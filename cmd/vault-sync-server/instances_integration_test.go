//go:build integration

package main_test

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// These tests run several server processes ("instances") against one
// PostgreSQL database and one S3 bucket, as replicas of an HA deployment
// behind a load balancer do (SPEC.md §12).

// deployment is the shared infrastructure of several instances.
type deployment struct {
	database store.Config
	objects  blobstore.Config
	issuer   *authtest.Issuer
	key      authtest.Key
}

func newDeployment(t *testing.T) *deployment {
	t.Helper()

	database := testinfra.PostgresConfig(t)
	objects := testinfra.S3Bucket(t)
	issuer := authtest.NewIssuer(t)

	return &deployment{database: database, objects: objects, issuer: issuer, key: issuer.AddKey(t, jose.ES256)}
}

// token returns a fresh access token for subject.
func (cluster *deployment) token(t *testing.T, subject string) string {
	t.Helper()

	return authtest.Sign(t, cluster.key, cluster.issuer.Claims(subject, time.Now()))
}

// syncBuffer collects a child's output; it may be read while the child runs.
type syncBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *syncBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()

	return buffer.buffer.Write(data)
}

func (buffer *syncBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()

	return buffer.buffer.String()
}

// instance is one running server process.
type instance struct {
	name           string
	process        *child
	apiURL         string
	metricsAddress string
	logs           *syncBuffer
}

// start runs binary as a new instance of the deployment, with extra
// environment variables, and returns once it is ready.
func (cluster *deployment) start(t *testing.T, name, binary string, extra ...string) *instance {
	t.Helper()

	var server *instance

	// Starts a new process, with new addresses, if another process took
	// one of the ports first.
	testinfra.StartServer(t, name, 60*time.Second, func(addresses testinfra.ServerAddresses) testinfra.ServerProcess {
		attempt := &instance{
			name:           name,
			process:        newChild(t, binary),
			apiURL:         "http://" + addresses.API,
			metricsAddress: addresses.Metrics,
			logs:           &syncBuffer{},
		}

		attempt.process.Command.Env = append([]string{
			config.DatabaseURLEnv + "=" + cluster.database.DSN,
			config.ListenAddressEnv + "=" + addresses.API,
			config.MetricsListenAddressEnv + "=" + addresses.Metrics,
			config.OIDCIssuerURLEnv + "=" + cluster.issuer.URL,
			config.OIDCAudienceEnv + "=" + authtest.DefaultAudience,
			config.S3EndpointEnv + "=" + cluster.objects.Endpoint,
			config.S3RegionEnv + "=" + cluster.objects.Region,
			config.S3BucketEnv + "=" + cluster.objects.Bucket,
			config.S3AccessKeyIDFileEnv + "=" + cluster.objects.AccessKeyIDFile,
			config.S3SecretAccessKeyFileEnv + "=" + cluster.objects.SecretAccessKeyFile,
			config.S3ForcePathStyleEnv + "=" + strconv.FormatBool(cluster.objects.ForcePathStyle),
			config.ShutdownDelayEnv + "=0s",
		}, extra...)
		attempt.process.Command.Stdout = attempt.logs
		attempt.process.Command.Stderr = attempt.logs

		// Registered before the process's own cleanup, so it runs after the
		// process has been stopped.
		t.Cleanup(func() {
			if t.Failed() {
				t.Logf("%s logs:\n%s", name, attempt.logs.String())
			}
		})

		attempt.process.Start(t)
		server = attempt

		return testinfra.ServerProcess{Exited: attempt.process.Exited(), Err: attempt.process.Err, Output: attempt.logs.String}
	})

	return server
}

// kill kills the instance without warning (SIGKILL) and waits for it to die.
func (server *instance) kill(t *testing.T) {
	t.Helper()

	require.NoError(t, server.process.Command.Process.Kill())
	<-server.process.Exited()
}

// httpClient does not reuse connections across instances' lifetimes: each
// request may go to a different instance, as through a load balancer.
var httpClient = &http.Client{Timeout: 2 * time.Minute}

func (server *instance) vaults() vaultsyncv1connect.VaultServiceClient {
	return vaultsyncv1connect.NewVaultServiceClient(httpClient, server.apiURL)
}

func (server *instance) blobs() vaultsyncv1connect.BlobServiceClient {
	return vaultsyncv1connect.NewBlobServiceClient(httpClient, server.apiURL, connect.WithSendMaxBytes(1<<20))
}

func authorized[T any](message *T, token string) *connect.Request[T] {
	request := connect.NewRequest(message)
	request.Header().Set("Authorization", "Bearer "+token)

	return request
}

func createVault(t *testing.T, server *instance, token, name string) *vaultsyncv1.Vault {
	t.Helper()

	response, err := server.vaults().CreateVault(t.Context(), authorized(&vaultsyncv1.CreateVaultRequest{
		Name: name, Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE,
	}, token))
	require.NoError(t, err, "create vault on %s", server.name)

	return response.Msg.GetVault()
}

func listVaultIDs(t *testing.T, server *instance, token string) []string {
	t.Helper()

	response, err := server.vaults().ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{}, token))
	require.NoError(t, err, "list vaults on %s", server.name)

	ids := make([]string, 0, len(response.Msg.GetVaults()))
	for _, vault := range response.Msg.GetVaults() {
		ids = append(ids, vault.GetId())
	}

	return ids
}

// randomBlob returns size random bytes and their blob id.
func randomBlob(t *testing.T, size int) ([]byte, []byte) {
	t.Helper()

	content := make([]byte, size)
	_, err := rand.Read(content)
	require.NoError(t, err)

	sum := sha256.Sum256(content)

	return content, sum[:]
}

// blobClient is one client's view of a blob upload, sending each request to
// whichever instance the test names.
type blobClient struct {
	token   string
	vaultID string
	blobID  []byte
	content []byte
}

func (client *blobClient) begin(t *testing.T, server *instance) (*vaultsyncv1.BeginBlobResponse, error) {
	t.Helper()

	response, err := server.blobs().BeginBlob(t.Context(), authorized(&vaultsyncv1.BeginBlobRequest{
		VaultId: client.vaultID, BlobId: client.blobID, Size: uint64(len(client.content)),
	}, client.token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

// put sends the chunk at offset and returns the server's received size.
func (client *blobClient) put(t *testing.T, server *instance, offset int) (int, error) {
	t.Helper()

	response, err := server.blobs().PutBlobChunk(t.Context(), authorized(client.chunk(offset), client.token))
	if err != nil {
		return 0, err
	}

	return int(response.Msg.GetReceivedSize()), nil
}

func (client *blobClient) chunk(offset int) *vaultsyncv1.PutBlobChunkRequest {
	end := min(offset+config.DefaultBlobMaxChunkBytes, len(client.content))

	return &vaultsyncv1.PutBlobChunkRequest{
		VaultId: client.vaultID, BlobId: client.blobID, Offset: uint64(offset), Data: client.content[offset:end],
	}
}

// sendChunks sends chunks from offset until the content is all received or
// chunks chunks were sent (if chunks is positive), sending chunk n to
// servers[n % len(servers)]. It returns the received size.
func (client *blobClient) sendChunks(t *testing.T, offset, chunks int, servers ...*instance) int {
	t.Helper()

	for sent := 0; offset < len(client.content) && (chunks <= 0 || sent < chunks); sent++ {
		server := servers[sent%len(servers)]

		received, err := client.put(t, server, offset)
		require.NoError(t, err, "put chunk at %d on %s", offset, server.name)
		require.Greater(t, received, offset, "chunk at %d on %s made no progress", offset, server.name)

		offset = received
	}

	return offset
}

func (client *blobClient) commit(t *testing.T, server *instance) (*vaultsyncv1.CommitBlobResponse, error) {
	t.Helper()

	response, err := server.blobs().CommitBlob(t.Context(), authorized(&vaultsyncv1.CommitBlobRequest{
		VaultId: client.vaultID, BlobId: client.blobID,
	}, client.token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

// download downloads the whole blob, sending range n to
// servers[n % len(servers)].
func (client *blobClient) download(t *testing.T, servers ...*instance) []byte {
	t.Helper()

	downloaded := []byte{}

	for index := 0; ; index++ {
		server := servers[index%len(servers)]

		response, err := server.blobs().DownloadBlob(t.Context(), authorized(&vaultsyncv1.DownloadBlobRequest{
			VaultId: client.vaultID, BlobId: client.blobID, Offset: uint64(len(downloaded)),
		}, client.token))
		require.NoError(t, err, "download from %d on %s", len(downloaded), server.name)

		downloaded = append(downloaded, response.Msg.GetData()...)
		if uint64(len(downloaded)) >= response.Msg.GetSize() {
			return downloaded
		}

		require.NotEmpty(t, response.Msg.GetData(), "download made no progress")
	}
}

// requireStored checks that the blob is complete and downloads intact,
// alternating over servers.
func (client *blobClient) requireStored(t *testing.T, servers ...*instance) {
	t.Helper()

	for _, server := range servers {
		begun, err := client.begin(t, server)
		require.NoError(t, err, "begin on %s", server.name)
		require.True(t, begun.GetComplete(), "%s must report the blob complete", server.name)
	}

	require.True(t, bytes.Equal(client.content, client.download(t, servers...)), "downloaded content differs")
}
