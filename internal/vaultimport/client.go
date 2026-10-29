package vaultimport

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"connectrpc.com/connect"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"golang.org/x/oauth2"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
)

// requestTimeout bounds every HTTP request the import makes, so a stalled
// server or identity provider cannot hang it.
const requestTimeout = 2 * time.Minute

// signInScopes are the scopes the sign-in asks for, as the plugin does:
// offline_access asks for a refresh token, so a long import keeps a valid
// access token.
var signInScopes = []string{oidc.ScopeOpenID, oidc.ScopeOfflineAccess}

// apiClient calls the server's API as the signed-in user.
type apiClient struct {
	vaults  vaultsyncv1connect.VaultServiceClient
	devices vaultsyncv1connect.DeviceServiceClient
	blobs   vaultsyncv1connect.BlobServiceClient
	sync    vaultsyncv1connect.SyncServiceClient
}

// signIn signs in to the identity provider the server at serverURL names,
// with the OIDC device authorization grant (RFC 8628): it writes the address
// and code the user approves the sign-in with to prompt, and waits for the
// approval. The returned client sends the access token, refreshed as needed,
// with every request.
func signIn(ctx context.Context, serverURL string, prompt io.Writer) (*apiClient, error) {
	httpClient := &http.Client{Timeout: requestTimeout}

	info, err := vaultsyncv1connect.NewServerInfoServiceClient(httpClient, serverURL).
		GetServerInfo(ctx, connect.NewRequest(&vaultsyncv1.GetServerInfoRequest{}))
	if err != nil {
		return nil, fmt.Errorf("get the server's information: %w", err)
	}

	issuer, clientID := info.Msg.GetOidcIssuerUrl(), info.Msg.GetOidcClientId()
	if issuer == "" || clientID == "" {
		return nil, errors.New("the server advertises no OIDC issuer and client id to sign in with; set VAULT_SYNC_OIDC_CLIENT_ID on the server")
	}

	oidcCtx := oidc.ClientContext(ctx, httpClient)

	provider, err := oidc.NewProvider(oidcCtx, issuer)
	if err != nil {
		return nil, fmt.Errorf("discover the identity provider %s: %w", issuer, err)
	}

	endpoint := provider.Endpoint()
	if endpoint.DeviceAuthURL == "" {
		return nil, fmt.Errorf("the identity provider %s does not support the device authorization grant", issuer)
	}

	// A public client: the client id goes in the form, with no secret.
	endpoint.AuthStyle = oauth2.AuthStyleInParams

	oauthConfig := &oauth2.Config{ClientID: clientID, Endpoint: endpoint, Scopes: signInScopes}

	authorization, err := oauthConfig.DeviceAuth(oidcCtx)
	if err != nil {
		return nil, fmt.Errorf("start the sign-in: %w", err)
	}

	if authorization.VerificationURIComplete != "" {
		_, _ = fmt.Fprintf(prompt, "To sign in, open %s and confirm the code %s\n", authorization.VerificationURIComplete, authorization.UserCode)
	} else {
		_, _ = fmt.Fprintf(prompt, "To sign in, open %s and enter the code %s\n", authorization.VerificationURI, authorization.UserCode)
	}

	token, err := oauthConfig.DeviceAccessToken(oidcCtx, authorization)
	if err != nil {
		return nil, fmt.Errorf("sign in: %w", err)
	}

	authorized := &http.Client{
		Timeout:   requestTimeout,
		Transport: &oauth2.Transport{Source: oauthConfig.TokenSource(oidcCtx, token), Base: http.DefaultTransport},
	}

	return &apiClient{
		vaults:  vaultsyncv1connect.NewVaultServiceClient(authorized, serverURL),
		devices: vaultsyncv1connect.NewDeviceServiceClient(authorized, serverURL),
		blobs:   vaultsyncv1connect.NewBlobServiceClient(authorized, serverURL),
		sync:    vaultsyncv1connect.NewSyncServiceClient(authorized, serverURL),
	}, nil
}

// checkVault checks that the signed-in user may import into vaultID: they
// are an owner or editor of it, and it is a plaintext vault that has never
// had a document.
func (client *apiClient) checkVault(ctx context.Context, vaultID uuid.UUID) error {
	var vault *vaultsyncv1.Vault

	for pageToken := ""; vault == nil; {
		response, err := client.vaults.ListVaults(ctx, connect.NewRequest(&vaultsyncv1.ListVaultsRequest{PageToken: pageToken}))
		if err != nil {
			return fmt.Errorf("list your vaults: %w", err)
		}

		for _, candidate := range response.Msg.GetVaults() {
			if candidate.GetId() == vaultID.String() {
				vault = candidate
			}
		}

		pageToken = response.Msg.GetNextPageToken()
		if pageToken == "" {
			break
		}
	}

	switch {
	case vault == nil:
		return fmt.Errorf("vault %s does not exist or you are not a member of it", vaultID)
	case vault.GetRole() != vaultsyncv1.VaultRole_VAULT_ROLE_OWNER && vault.GetRole() != vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR:
		return fmt.Errorf("you are a viewer of vault %s; importing needs the editor or owner role", vaultID)
	case vault.GetEncryption() != vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE:
		return fmt.Errorf("vault %s is end-to-end encrypted; only plaintext vaults can be imported into", vaultID)
	case vault.GetHeadSeq() != 0:
		return fmt.Errorf("vault %s is not empty; import only into a new vault", vaultID)
	}

	return nil
}

// registerDevice registers the device the import commits as.
func (client *apiClient) registerDevice(ctx context.Context) (string, error) {
	response, err := client.devices.RegisterDevice(ctx, connect.NewRequest(&vaultsyncv1.RegisterDeviceRequest{Name: DeviceName}))
	if err != nil {
		return "", fmt.Errorf("register the import device: %w", err)
	}

	return response.Msg.GetDevice().GetId(), nil
}

// removeDevice removes the device registerDevice registered.
func (client *apiClient) removeDevice(ctx context.Context, deviceID string) error {
	_, err := client.devices.RemoveDevice(ctx, connect.NewRequest(&vaultsyncv1.RemoveDeviceRequest{DeviceId: deviceID}))

	return err
}

// APITarget creates documents through the server's API, as a device does:
// it uploads the content as a blob under its SHA-256, then commits one
// revision that creates the document.
type APITarget struct {
	client   *apiClient
	vaultID  uuid.UUID
	deviceID string
}

// Create implements Target.
func (target *APITarget) Create(ctx context.Context, entry Entry) error {
	documentID, err := uuid.NewV7()
	if err != nil {
		return err
	}

	revisionID, err := uuid.NewV7()
	if err != nil {
		return err
	}

	request := &vaultsyncv1.CommitRevisionRequest{
		VaultId:    target.vaultID.String(),
		DocumentId: documentID.String(),
		RevisionId: revisionID.String(),
		// A plaintext vault's path key is derived by the server.
		Path:     []byte(entry.Path),
		DeviceId: target.deviceID,
	}

	switch entry.Kind {
	case KindText:
		request.Kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT
	case KindBlob:
		request.Kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB
	case KindFolder:
		request.Kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER
	}

	if entry.Kind != KindFolder {
		blobID, err := target.upload(ctx, entry.Content)
		if err != nil {
			return err
		}

		request.ContentRef = &vaultsyncv1.ContentRef{BlobId: blobID, Size: uint64(len(entry.Content))}
	}

	_, err = target.client.sync.CommitRevision(ctx, connect.NewRequest(request))
	if connect.CodeOf(err) == connect.CodeAlreadyExists {
		return &SkipError{Reason: "the server refused the name: " + connectMessage(err)}
	}

	if err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	return nil
}

// upload stores content as a blob, resuming an earlier partial upload of
// the same content, and returns its id.
func (target *APITarget) upload(ctx context.Context, content []byte) ([]byte, error) {
	sum := sha256.Sum256(content)
	blobID := sum[:]
	vaultID := target.vaultID.String()

	begun, err := target.client.blobs.BeginBlob(ctx, connect.NewRequest(&vaultsyncv1.BeginBlobRequest{
		VaultId: vaultID, BlobId: blobID, Size: uint64(len(content)),
	}))
	if connect.CodeOf(err) == connect.CodeInvalidArgument {
		// The request is well formed, so the server refuses the size.
		return nil, &SkipError{Reason: "the server refused the file: " + connectMessage(err)}
	}

	if err != nil {
		return nil, fmt.Errorf("begin the upload: %w", err)
	}

	if begun.Msg.GetComplete() {
		return blobID, nil
	}

	chunkSize := uint64(begun.Msg.GetMaxChunkSize())
	if chunkSize == 0 {
		return nil, errors.New("the server sets no chunk size for uploads")
	}

	for offset := begun.Msg.GetReceivedSize(); offset < uint64(len(content)); {
		end := min(offset+chunkSize, uint64(len(content)))

		put, err := target.client.blobs.PutBlobChunk(ctx, connect.NewRequest(&vaultsyncv1.PutBlobChunkRequest{
			VaultId: vaultID, BlobId: blobID, Offset: offset, Data: content[offset:end],
		}))
		if err != nil {
			return nil, fmt.Errorf("upload: %w", err)
		}

		if put.Msg.GetReceivedSize() <= offset {
			return nil, fmt.Errorf("upload: the server received nothing at offset %d", offset)
		}

		offset = put.Msg.GetReceivedSize()
	}

	if _, err := target.client.blobs.CommitBlob(ctx, connect.NewRequest(&vaultsyncv1.CommitBlobRequest{
		VaultId: vaultID, BlobId: blobID,
	})); err != nil {
		return nil, fmt.Errorf("finish the upload: %w", err)
	}

	return blobID, nil
}

// connectMessage returns the server's message in err, without the code.
func connectMessage(err error) string {
	var connectErr *connect.Error
	if errors.As(err, &connectErr) {
		return connectErr.Message()
	}

	return err.Error()
}
