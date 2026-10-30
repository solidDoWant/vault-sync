//go:build integration

package server_test

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// defaultBlobLimits are the production defaults.
var defaultBlobLimits = api.BlobLimits{
	MaxChunkBytes:      config.DefaultBlobMaxChunkBytes,
	MaxBlobBytes:       config.DefaultBlobMaxSizeBytes,
	MaxUploadsPerVault: config.DefaultBlobMaxUploadsPerVault,
}

// blobFixture serves the full API, with blobs, against real PostgreSQL and
// S3 and the production request limit.
type blobFixture struct {
	*authFixture

	pool    *pgxpool.Pool
	objects *blobstore.Objects
	limits  api.BlobLimits
}

func newBlobFixture(t *testing.T, limits api.BlobLimits) *blobFixture {
	t.Helper()

	return newBlobFixtureWithRequestLimit(t, limits, config.DefaultMaxRequestBytes)
}

// newBlobFixtureWithRequestLimit is newBlobFixture with another request (and
// send) limit.
func newBlobFixtureWithRequestLimit(t *testing.T, limits api.BlobLimits, maxRequestBytes int64) *blobFixture {
	t.Helper()

	pool := migratedPool(t)
	queries := store.New(pool)

	objectMetrics := blobstore.NewMetrics()

	objects, err := blobstore.NewWithMetrics(testinfra.S3Bucket(t), objectMetrics)
	require.NoError(t, err)

	issuer := authtest.NewIssuer(t)
	fixture := &authFixture{issuer: issuer, key: issuer.AddKey(t, jose.RS256), logs: &syncBuffer{}}
	logger := slog.New(slog.NewJSONHandler(fixture.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))

	verifier := auth.NewVerifier(auth.VerifierOptions{IssuerURL: issuer.URL, Audience: authtest.DefaultAudience, Logger: logger})

	fixture.running = startServer(t, server.Options{
		MaxRequestBytes: maxRequestBytes,
		Database:        pool,
		Authenticator:   auth.NewAuthenticator(verifier, queries),
		Devices:         queries,
		Vaults:          queries,
		Memberships:     queries,
		Blobs:           &api.BlobService{Store: queries, Objects: objects, Limits: limits, Metrics: objectMetrics},
		Dependencies:    server.DependencyMetrics{ObjectStore: objectMetrics},
		Logger:          logger,
	})

	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("server logs:\n%s", fixture.logs.String())
		}
	})

	return &blobFixture{authFixture: fixture, pool: pool, objects: objects, limits: limits}
}

func (fixture *blobFixture) blobs() vaultsyncv1connect.BlobServiceClient {
	return vaultsyncv1connect.NewBlobServiceClient(http.DefaultClient, fixture.running.apiURL())
}

// addMember seeds a membership; membership management is Phase 3.
func (fixture *blobFixture) addMember(t *testing.T, vaultID, subject string, role store.Role) {
	t.Helper()

	fixture.listVaults(t, fixture.token(t, subject)) // provisions the user

	_, err := fixture.pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, $3)`,
		vaultID, userID(t, fixture.pool, fixture.issuer.URL, subject), role)
	require.NoError(t, err)
}

func randomBytes(t *testing.T, size int) []byte {
	t.Helper()

	data := make([]byte, size)
	_, err := rand.Read(data)
	require.NoError(t, err)

	return data
}

func blobIDOf(content []byte) []byte {
	sum := sha256.Sum256(content)

	return sum[:]
}

func (fixture *blobFixture) begin(t *testing.T, token, vaultID string, blobID []byte, size int) (*vaultsyncv1.BeginBlobResponse, error) {
	t.Helper()

	response, err := fixture.blobs().BeginBlob(t.Context(), authorized(&vaultsyncv1.BeginBlobRequest{
		VaultId: vaultID, BlobId: blobID, Size: uint64(size),
	}, token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

func (fixture *blobFixture) put(t *testing.T, token, vaultID string, blobID []byte, offset int, data []byte) (*vaultsyncv1.PutBlobChunkResponse, error) {
	t.Helper()

	response, err := fixture.blobs().PutBlobChunk(t.Context(), authorized(&vaultsyncv1.PutBlobChunkRequest{
		VaultId: vaultID, BlobId: blobID, Offset: uint64(offset), Data: data,
	}, token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

func (fixture *blobFixture) commit(t *testing.T, token, vaultID string, blobID []byte) (*vaultsyncv1.CommitBlobResponse, error) {
	t.Helper()

	response, err := fixture.blobs().CommitBlob(t.Context(), authorized(&vaultsyncv1.CommitBlobRequest{
		VaultId: vaultID, BlobId: blobID,
	}, token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

func (fixture *blobFixture) download(t *testing.T, token, vaultID string, blobID []byte, offset, length int) (*vaultsyncv1.DownloadBlobResponse, error) {
	t.Helper()

	response, err := fixture.blobs().DownloadBlob(t.Context(), authorized(&vaultsyncv1.DownloadBlobRequest{
		VaultId: vaultID, BlobId: blobID, Offset: uint64(offset), Length: uint32(length),
	}, token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

// sendFrom uploads content[from:] in chunks of the server's maximum chunk
// size, stopping early (without error) after maxChunks chunks if positive.
func (fixture *blobFixture) sendFrom(t *testing.T, token, vaultID string, blobID, content []byte, from, maxChunks int) error {
	t.Helper()

	sent := 0

	for offset := from; offset < len(content); {
		if maxChunks > 0 && sent == maxChunks {
			return nil
		}

		end := min(offset+int(fixture.limits.MaxChunkBytes), len(content))

		response, err := fixture.put(t, token, vaultID, blobID, offset, content[offset:end])
		if err != nil {
			return err
		}

		offset = int(response.GetReceivedSize())
		sent++
	}

	return nil
}

// upload uploads content as one client following the protocol.
func (fixture *blobFixture) upload(t *testing.T, token, vaultID string, blobID, content []byte) error {
	t.Helper()

	begun, err := fixture.begin(t, token, vaultID, blobID, len(content))
	if err != nil {
		return err
	}

	if begun.GetComplete() {
		return nil
	}

	if err := fixture.sendFrom(t, token, vaultID, blobID, content, int(begun.GetReceivedSize()), 0); err != nil {
		return err
	}

	_, err = fixture.commit(t, token, vaultID, blobID)

	return err
}

// downloadAll downloads a blob in server-bounded ranges.
func (fixture *blobFixture) downloadAll(t *testing.T, token, vaultID string, blobID []byte) []byte {
	t.Helper()

	content := []byte{}

	for {
		response, err := fixture.download(t, token, vaultID, blobID, len(content), 0)
		require.NoError(t, err)
		require.LessOrEqual(t, int64(len(response.GetData())), fixture.limits.MaxChunkBytes)

		content = append(content, response.GetData()...)
		if uint64(len(content)) >= response.GetSize() {
			return content
		}

		require.NotEmpty(t, response.GetData(), "download made no progress")
	}
}

func (fixture *blobFixture) objectExists(t *testing.T, key string) bool {
	t.Helper()

	_, err := fixture.objects.Client().HeadObject(t.Context(), &s3.HeadObjectInput{
		Bucket: aws.String(fixture.objects.Bucket()), Key: aws.String(key),
	})

	return err == nil
}

func (fixture *blobFixture) objectCount(t *testing.T, prefix string) int {
	t.Helper()

	listed, err := fixture.objects.Client().ListObjectsV2(t.Context(), &s3.ListObjectsV2Input{
		Bucket: aws.String(fixture.objects.Bucket()), Prefix: aws.String(prefix),
	})
	require.NoError(t, err)

	return len(listed.Contents)
}

func (fixture *blobFixture) blobRows(t *testing.T) int {
	t.Helper()

	var count int

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM blobs`).Scan(&count))

	return count
}

func requireCode(t *testing.T, want connect.Code, err error, msgAndArgs ...any) {
	t.Helper()

	require.Error(t, err, msgAndArgs...)
	require.Equal(t, want, connect.CodeOf(err), append(msgAndArgs, err.Error())...)
}

// Criterion 1: a blob larger than the chunk size is stored at
// vaults/{vault_id}/blobs/{blob_id} and downloads byte-identical, in full and
// by range.
func TestBlobUploadAndDownload(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")
	vaultID := uuid.MustParse(vault.GetId())

	tests := []struct {
		name string
		size int
	}{
		// Composed with a multipart upload (larger than one part).
		{name: "multipart", size: blobstore.PartSize + 3*config.DefaultBlobMaxChunkBytes + 12345},
		// Composed with a single PutObject.
		{name: "several chunks", size: 3*config.DefaultBlobMaxChunkBytes + 17},
		{name: "exactly one chunk", size: config.DefaultBlobMaxChunkBytes},
		{name: "empty", size: 0},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			content := randomBytes(t, test.size)
			blobID := blobIDOf(content)

			require.NoError(t, fixture.upload(t, token, vault.GetId(), blobID, content))

			assert.True(t, fixture.objectExists(t, blobstore.BlobKey(vaultID, blobID)), "blob object at vaults/{vault_id}/blobs/{blob_id}")
			assert.Equal(t, "vaults/"+vault.GetId()+"/blobs/", blobstore.BlobKey(vaultID, blobID)[:len("vaults/"+vault.GetId()+"/blobs/")])
			assert.Equal(t, content, fixture.downloadAll(t, token, vault.GetId(), blobID))

			// Staged chunks are removed once the blob is complete.
			assert.Zero(t, fixture.objectCount(t, blobstore.VaultPrefix(vaultID)+"uploads/"))

			for _, window := range []struct{ offset, length int }{
				{0, 1},
				{1, 1000},
				{test.size / 2, 4096},
				{max(test.size-10, 0), 100},
				{test.size, 0},
			} {
				if window.offset > test.size {
					continue
				}

				response, err := fixture.download(t, token, vault.GetId(), blobID, window.offset, window.length)
				require.NoError(t, err, "range %+v", window)

				end := min(window.offset+window.length, test.size)
				if window.length == 0 {
					end = min(window.offset+int(fixture.limits.MaxChunkBytes), test.size)
				}

				// Protobuf decodes empty bytes as nil, so compare contents.
				assert.True(t, bytes.Equal(content[window.offset:end], response.GetData()), "range %+v", window)
				assert.Len(t, response.GetData(), end-window.offset, "range %+v", window)
				assert.Equal(t, uint64(test.size), response.GetSize())
			}

			_, err := fixture.download(t, token, vault.GetId(), blobID, test.size+1, 0)
			requireCode(t, connect.CodeInvalidArgument, err, "offset beyond the end")
		})
	}
}

func TestBlobTransfersAreCountedInTheMetrics(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")

	content := randomBytes(t, 2*config.DefaultBlobMaxChunkBytes+17)
	blobID := blobIDOf(content)

	require.NoError(t, fixture.upload(t, token, vault.GetId(), blobID, content))
	uploaded, err := strconv.ParseFloat(metricValue(t, fixture.running, "vault_sync_blob_uploaded_bytes_total"), 64)
	require.NoError(t, err)
	assert.Equal(t, float64(len(content)), uploaded)
	assert.Equal(t, "0", metricValue(t, fixture.running, "vault_sync_blob_downloaded_bytes_total"))

	_, err = fixture.download(t, token, vault.GetId(), blobID, 5, 100)
	require.NoError(t, err)
	assert.Equal(t, "100", metricValue(t, fixture.running, "vault_sync_blob_downloaded_bytes_total"))

	// Each staged chunk and the composed blob were written to S3.
	assert.NotEmpty(t, metricValue(t, fixture.running, `vault_sync_s3_requests_total{operation="PutObject",outcome="ok"}`))
}

// Criterion 2: committed bytes that do not hash to blob_id fail the commit
// and nothing becomes visible.
func TestCommitRejectsContentThatDoesNotMatchTheBlobID(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")
	vaultID := uuid.MustParse(vault.GetId())

	for _, size := range []int{2*config.DefaultBlobMaxChunkBytes + 5, blobstore.PartSize + config.DefaultBlobMaxChunkBytes} {
		content := randomBytes(t, size)
		claimed := blobIDOf(append([]byte("something else"), content...))

		err := fixture.upload(t, token, vault.GetId(), claimed, content)
		requireCode(t, connect.CodeInvalidArgument, err, "size %d", size)

		assert.False(t, fixture.objectExists(t, blobstore.BlobKey(vaultID, claimed)), "no blob object")
		assert.Zero(t, fixture.blobRows(t), "no blob row")

		_, err = fixture.download(t, token, vault.GetId(), claimed, 0, 0)
		requireCode(t, connect.CodeNotFound, err)

		// The upload was discarded, staged chunks and all: a retry starts
		// from scratch.
		assert.Zero(t, fixture.objectCount(t, blobstore.VaultPrefix(vaultID)+"uploads/"))

		begun, err := fixture.begin(t, token, vault.GetId(), claimed, size)
		require.NoError(t, err)
		assert.False(t, begun.GetComplete())
		assert.Zero(t, begun.GetReceivedSize())
	}
}

// Criterion 3: beginning the upload of a blob that already exists reports it
// complete, and no bytes are transferred.
func TestBeginBlobShortCircuitsACompleteBlob(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	alice := fixture.token(t, "alice")
	vault := fixture.createVault(t, alice, "Notes")
	fixture.addMember(t, vault.GetId(), "bob", store.RoleEditor)
	bob := fixture.token(t, "bob")

	content := randomBytes(t, config.DefaultBlobMaxChunkBytes+10)
	blobID := blobIDOf(content)
	require.NoError(t, fixture.upload(t, alice, vault.GetId(), blobID, content))

	// Another device (of another member) uploading the same content.
	begun, err := fixture.begin(t, bob, vault.GetId(), blobID, len(content))
	require.NoError(t, err)
	assert.True(t, begun.GetComplete())
	assert.Equal(t, uint64(len(content)), begun.GetReceivedSize())

	var sessions int

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM blob_uploads`).Scan(&sessions))
	assert.Zero(t, sessions, "no upload session is opened")

	_, err = fixture.put(t, bob, vault.GetId(), blobID, 0, content[:10])
	requireCode(t, connect.CodeFailedPrecondition, err, "no upload is in progress")

	committed, err := fixture.commit(t, bob, vault.GetId(), blobID)
	require.NoError(t, err, "committing a complete blob is idempotent")
	assert.Equal(t, uint64(len(content)), committed.GetSize())
}

// Criterion 4: an interrupted upload resumes from the bytes already stored.
func TestInterruptedUploadResumes(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")

	chunk := config.DefaultBlobMaxChunkBytes
	content := randomBytes(t, 5*chunk+99)
	blobID := blobIDOf(content)

	begun, err := fixture.begin(t, token, vault.GetId(), blobID, len(content))
	require.NoError(t, err)
	assert.Equal(t, uint32(chunk), begun.GetMaxChunkSize())
	require.NoError(t, fixture.sendFrom(t, token, vault.GetId(), blobID, content, 0, 3))

	// The client crashes and restarts: it learns what is stored...
	resumed, err := fixture.begin(t, token, vault.GetId(), blobID, len(content))
	require.NoError(t, err)
	assert.False(t, resumed.GetComplete())
	assert.Equal(t, uint64(3*chunk), resumed.GetReceivedSize())

	// ...cannot rewrite or skip ahead...
	_, err = fixture.put(t, token, vault.GetId(), blobID, 0, content[:chunk])
	requireCode(t, connect.CodeFailedPrecondition, err)
	_, err = fixture.put(t, token, vault.GetId(), blobID, 4*chunk, content[4*chunk:5*chunk])
	requireCode(t, connect.CodeFailedPrecondition, err)

	// ...cannot commit early...
	_, err = fixture.commit(t, token, vault.GetId(), blobID)
	requireCode(t, connect.CodeFailedPrecondition, err)

	// ...and sends only the rest.
	require.NoError(t, fixture.sendFrom(t, token, vault.GetId(), blobID, content, int(resumed.GetReceivedSize()), 0))

	committed, err := fixture.commit(t, token, vault.GetId(), blobID)
	require.NoError(t, err)
	assert.Equal(t, uint64(len(content)), committed.GetSize())
	assert.Equal(t, content, fixture.downloadAll(t, token, vault.GetId(), blobID))

	// A size that differs from the upload in progress is rejected.
	other := randomBytes(t, 2*chunk)
	_, err = fixture.begin(t, token, vault.GetId(), blobIDOf(other), len(other))
	require.NoError(t, err)
	_, err = fixture.begin(t, token, vault.GetId(), blobIDOf(other), len(other)+1)
	requireCode(t, connect.CodeInvalidArgument, err)
}

// Criterion 5: oversized chunks and blobs are rejected, and so are the other
// bounds: chunk framing, session count and download ranges.
func TestBlobBounds(t *testing.T) {
	limits := api.BlobLimits{MaxChunkBytes: 128 << 10, MaxBlobBytes: 1 << 20, MaxUploadsPerVault: 3}
	fixture := newBlobFixture(t, limits)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")
	content := randomBytes(t, 512<<10)
	blobID := blobIDOf(content)

	_, err := fixture.begin(t, token, vault.GetId(), blobID, len(content))
	require.NoError(t, err)

	t.Run("chunk above the maximum", func(t *testing.T) {
		_, err := fixture.put(t, token, vault.GetId(), blobID, 0, content[:limits.MaxChunkBytes+1])
		requireCode(t, connect.CodeInvalidArgument, err)
	})

	t.Run("chunk above the request body limit", func(t *testing.T) {
		big := randomBytes(t, config.DefaultMaxRequestBytes)
		_, err := fixture.put(t, token, vault.GetId(), blobID, 0, big)
		require.Error(t, err)

		begun, err := fixture.begin(t, token, vault.GetId(), blobID, len(content))
		require.NoError(t, err)
		assert.Zero(t, begun.GetReceivedSize(), "nothing was stored")
	})

	t.Run("empty chunk", func(t *testing.T) {
		_, err := fixture.put(t, token, vault.GetId(), blobID, 0, nil)
		requireCode(t, connect.CodeInvalidArgument, err)
	})

	t.Run("small chunk before the end", func(t *testing.T) {
		_, err := fixture.put(t, token, vault.GetId(), blobID, 0, content[:1000])
		requireCode(t, connect.CodeInvalidArgument, err)
	})

	t.Run("chunk past the declared size", func(t *testing.T) {
		small := randomBytes(t, 100)
		_, err := fixture.begin(t, token, vault.GetId(), blobIDOf(small), len(small))
		require.NoError(t, err)

		_, err = fixture.put(t, token, vault.GetId(), blobIDOf(small), 0, append(small, 0))
		requireCode(t, connect.CodeInvalidArgument, err)
	})

	t.Run("blob above the maximum", func(t *testing.T) {
		_, err := fixture.begin(t, token, vault.GetId(), blobIDOf([]byte("huge")), int(limits.MaxBlobBytes)+1)
		requireCode(t, connect.CodeInvalidArgument, err)
	})

	t.Run("malformed blob id", func(t *testing.T) {
		for _, malformed := range [][]byte{nil, blobID[:31], append(blobID, 0)} {
			_, err := fixture.begin(t, token, vault.GetId(), malformed, 10)
			requireCode(t, connect.CodeInvalidArgument, err)
			_, err = fixture.put(t, token, vault.GetId(), malformed, 0, []byte("x"))
			requireCode(t, connect.CodeInvalidArgument, err)
			_, err = fixture.commit(t, token, vault.GetId(), malformed)
			requireCode(t, connect.CodeInvalidArgument, err)
			_, err = fixture.download(t, token, vault.GetId(), malformed, 0, 0)
			requireCode(t, connect.CodeInvalidArgument, err)
		}
	})

	t.Run("too many uploads in progress", func(t *testing.T) {
		// Two sessions are open (above); one more fits.
		_, err := fixture.begin(t, token, vault.GetId(), blobIDOf([]byte("third")), 5)
		require.NoError(t, err)

		_, err = fixture.begin(t, token, vault.GetId(), blobIDOf([]byte("fourth")), 5)
		requireCode(t, connect.CodeResourceExhausted, err)

		// Resuming an existing session is not limited.
		_, err = fixture.begin(t, token, vault.GetId(), blobID, len(content))
		require.NoError(t, err)

		// Other vaults have their own allowance.
		other := fixture.createVault(t, token, "Other")
		_, err = fixture.begin(t, token, other.GetId(), blobIDOf([]byte("fourth")), 5)
		require.NoError(t, err)
	})

	t.Run("download ranges are capped by the server", func(t *testing.T) {
		require.NoError(t, fixture.sendFrom(t, token, vault.GetId(), blobID, content, 0, 0))
		_, err := fixture.commit(t, token, vault.GetId(), blobID)
		require.NoError(t, err)

		for _, length := range []int{0, int(limits.MaxChunkBytes) + 1, 1<<32 - 1} {
			response, err := fixture.download(t, token, vault.GetId(), blobID, 0, length)
			require.NoError(t, err)
			assert.Equal(t, content[:limits.MaxChunkBytes], response.GetData(), "length %d", length)
		}
	})
}

// Criterion 7 and per-role happy paths: owners and editors upload; every
// member downloads; viewers cannot upload; non-members get the same
// NOT_FOUND as for a vault that does not exist.
func TestBlobProceduresEnforceRoles(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	owner := fixture.token(t, "owner")
	vault := fixture.createVault(t, owner, "Shared")
	fixture.addMember(t, vault.GetId(), "editor", store.RoleEditor)
	fixture.addMember(t, vault.GetId(), "viewer", store.RoleViewer)

	tokens := map[store.Role]string{
		store.RoleOwner:  owner,
		store.RoleEditor: fixture.token(t, "editor"),
		store.RoleViewer: fixture.token(t, "viewer"),
		"non-member":     fixture.token(t, "outsider"),
	}

	fixture.listVaults(t, tokens["non-member"])

	uploaded := map[store.Role][]byte{}

	for _, role := range []store.Role{store.RoleOwner, store.RoleEditor} {
		t.Run(string(role)+" uploads and downloads", func(t *testing.T) {
			content := randomBytes(t, config.DefaultBlobMaxChunkBytes+int(role[0]))
			require.NoError(t, fixture.upload(t, tokens[role], vault.GetId(), blobIDOf(content), content))
			assert.Equal(t, content, fixture.downloadAll(t, tokens[role], vault.GetId(), blobIDOf(content)))

			uploaded[role] = content
		})
	}

	t.Run("viewer downloads but cannot upload", func(t *testing.T) {
		viewer := tokens[store.RoleViewer]

		for _, content := range uploaded {
			assert.Equal(t, content, fixture.downloadAll(t, viewer, vault.GetId(), blobIDOf(content)))
		}

		content := randomBytes(t, 100)
		_, err := fixture.begin(t, viewer, vault.GetId(), blobIDOf(content), len(content))
		requireCode(t, connect.CodePermissionDenied, err)

		// Even with an upload in progress (begun by an editor).
		_, err = fixture.begin(t, tokens[store.RoleEditor], vault.GetId(), blobIDOf(content), len(content))
		require.NoError(t, err)

		_, err = fixture.put(t, viewer, vault.GetId(), blobIDOf(content), 0, content)
		requireCode(t, connect.CodePermissionDenied, err)
		_, err = fixture.commit(t, viewer, vault.GetId(), blobIDOf(content))
		requireCode(t, connect.CodePermissionDenied, err)
	})

	t.Run("non-member is rejected as for a missing vault", func(t *testing.T) {
		outsider := tokens["non-member"]
		content := uploaded[store.RoleOwner]
		blobID := blobIDOf(content)

		for _, vaultID := range []string{vault.GetId(), uuid.Must(uuid.NewV7()).String()} {
			for _, call := range []func() error{
				func() error { _, err := fixture.begin(t, outsider, vaultID, blobID, len(content)); return err },
				func() error { _, err := fixture.put(t, outsider, vaultID, blobID, 0, content[:10]); return err },
				func() error { _, err := fixture.commit(t, outsider, vaultID, blobID); return err },
				func() error { _, err := fixture.download(t, outsider, vaultID, blobID, 0, 0); return err },
			} {
				err := call()
				requireCode(t, connect.CodeNotFound, err)

				var connectErr *connect.Error

				require.ErrorAs(t, err, &connectErr)
				assert.Equal(t, authz.ErrVaultNotFound.Error(), connectErr.Message())
			}
		}
	})

	// The schema-derived role matrix of #10 still holds with the blob
	// handlers mounted.
	t.Run("role matrix", func(t *testing.T) {
		for _, procedure := range vaultScopedProcedures(t) {
			access := expectedAccessOf(t, procedure)

			// The owner calls last, so the other roles' calls see the
			// vault before an owner-only procedure (DeleteVault) changes
			// it; it is the last procedure in the matrix.
			for _, role := range []store.Role{store.RoleEditor, store.RoleViewer, "non-member", store.RoleOwner} {
				response := fixture.callJSON(t, procedure, tokens[role], map[string]string{"vault_id": vault.GetId()})

				switch {
				case role == "non-member":
					assert.True(t, response.deniedAsNonMember(), "%s as %s: %s", procedure, role, response.body)
				case deniedByRole(role, access):
					assert.Equal(t, "permission_denied", response.code, "%s as %s", procedure, role)
				default:
					assert.NotEqual(t, "permission_denied", response.code, "%s as %s: %s", procedure, role, response.body)
					assert.False(t, response.deniedAsNonMember(), "%s as %s: %s", procedure, role, response.body)
				}
			}
		}
	})
}

// Issue #10 criterion 5, for blobs: a blob id from another vault is not
// found, even when the caller is a member of the vault they pass.
func TestBlobIDsFromAnotherVaultAreNotFound(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	alice := fixture.token(t, "alice")
	home := fixture.createVault(t, alice, "Home")
	other := fixture.createVault(t, alice, "Other")
	mallory := fixture.token(t, "mallory")
	mallorys := fixture.createVault(t, mallory, "Mallory's")

	content := randomBytes(t, 2*config.DefaultBlobMaxChunkBytes+1)
	blobID := blobIDOf(content)
	require.NoError(t, fixture.upload(t, alice, home.GetId(), blobID, content))

	// An upload in progress in the home vault, too.
	partial := randomBytes(t, 3*config.DefaultBlobMaxChunkBytes)
	partialID := blobIDOf(partial)
	_, err := fixture.begin(t, alice, home.GetId(), partialID, len(partial))
	require.NoError(t, err)
	require.NoError(t, fixture.sendFrom(t, alice, home.GetId(), partialID, partial, 0, 2))

	for name, caller := range map[string]struct{ token, vaultID string }{
		"member of both vaults":     {alice, other.GetId()},
		"owner of an unrelated one": {mallory, mallorys.GetId()},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := fixture.download(t, caller.token, caller.vaultID, blobID, 0, 0)
			requireCode(t, connect.CodeNotFound, err)

			_, err = fixture.commit(t, caller.token, caller.vaultID, partialID)
			requireCode(t, connect.CodeNotFound, err)

			_, err = fixture.put(t, caller.token, caller.vaultID, partialID, 2*config.DefaultBlobMaxChunkBytes, partial[2*config.DefaultBlobMaxChunkBytes:])
			requireCode(t, connect.CodeFailedPrecondition, err, "no upload of this blob in the caller's vault")

			// Beginning neither short-circuits on the other vault's blob nor
			// resumes its upload.
			begun, err := fixture.begin(t, caller.token, caller.vaultID, blobID, len(content))
			require.NoError(t, err)
			assert.False(t, begun.GetComplete())
			assert.Zero(t, begun.GetReceivedSize())

			begun, err = fixture.begin(t, caller.token, caller.vaultID, partialID, len(partial))
			require.NoError(t, err)
			assert.Zero(t, begun.GetReceivedSize())
		})
	}

	// The home vault is unaffected.
	assert.Equal(t, content, fixture.downloadAll(t, alice, home.GetId(), blobID))

	begun, err := fixture.begin(t, alice, home.GetId(), partialID, len(partial))
	require.NoError(t, err)
	assert.Equal(t, uint64(2*config.DefaultBlobMaxChunkBytes), begun.GetReceivedSize())
}

// Two devices uploading the same blob at once share one upload: whatever
// the interleaving, the result is the blob's exact content or, if a writer
// sent wrong bytes, nothing at all.
func TestConcurrentUploadsOfTheSameBlob(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	alice := fixture.token(t, "alice")
	vault := fixture.createVault(t, alice, "Notes")
	fixture.addMember(t, vault.GetId(), "bob", store.RoleEditor)
	bob := fixture.token(t, "bob")

	t.Run("honest devices", func(t *testing.T) {
		content := randomBytes(t, 6*config.DefaultBlobMaxChunkBytes+7)
		blobID := blobIDOf(content)

		var group sync.WaitGroup

		errs := make([]error, 4)

		for index := range errs {
			group.Go(func() {
				token := []string{alice, bob}[index%2]

				// Retry like a client: a conflict means another device
				// moved the upload on, so resume from BeginBlob.
				for range 200 {
					errs[index] = fixture.upload(t, token, vault.GetId(), blobID, content)
					if connect.CodeOf(errs[index]) != connect.CodeFailedPrecondition {
						return
					}
				}
			})
		}

		group.Wait()

		for _, err := range errs {
			require.NoError(t, err)
		}

		assert.Equal(t, content, fixture.downloadAll(t, alice, vault.GetId(), blobID))
	})

	t.Run("a device sending wrong bytes", func(t *testing.T) {
		chunk := config.DefaultBlobMaxChunkBytes
		content := randomBytes(t, 2*chunk+3)
		blobID := blobIDOf(content)

		_, err := fixture.begin(t, alice, vault.GetId(), blobID, len(content))
		require.NoError(t, err)
		_, err = fixture.put(t, alice, vault.GetId(), blobID, 0, content[:chunk])
		require.NoError(t, err)

		// Bob's device continues the shared upload with corrupt bytes.
		_, err = fixture.put(t, bob, vault.GetId(), blobID, chunk, randomBytes(t, chunk))
		require.NoError(t, err)

		// Alice's next chunk at the same offset loses.
		_, err = fixture.put(t, alice, vault.GetId(), blobID, chunk, content[chunk:2*chunk])
		requireCode(t, connect.CodeFailedPrecondition, err)

		require.NoError(t, fixture.sendFrom(t, alice, vault.GetId(), blobID, content, 2*chunk, 0))

		_, err = fixture.commit(t, alice, vault.GetId(), blobID)
		requireCode(t, connect.CodeInvalidArgument, err)

		_, err = fixture.download(t, alice, vault.GetId(), blobID, 0, 0)
		requireCode(t, connect.CodeNotFound, err, "nothing visible")

		// Alice retries from scratch and succeeds.
		require.NoError(t, fixture.upload(t, alice, vault.GetId(), blobID, content))
		assert.Equal(t, content, fixture.downloadAll(t, bob, vault.GetId(), blobID))
	})
}

// End-to-end encrypted vaults address blobs by the SHA-256 of the sealed
// bytes, which the server verifies as in plaintext vaults (SPEC.md §5), so a
// resumed or shared upload spliced from two ciphertexts is refused. The vault
// is seeded directly.
func TestEndToEndEncryptedVaultsVerifyTheHashOfTheSealedBytes(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	token := fixture.token(t, "alice")
	fixture.listVaults(t, token)

	vaultID := uuid.Must(uuid.NewV7()).String()
	_, err := fixture.pool.Exec(t.Context(), `INSERT INTO vaults (id, name, encryption) VALUES ($1, 'Secret', 'e2ee')`, vaultID)
	require.NoError(t, err)
	_, err = fixture.pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'owner')`,
		vaultID, userID(t, fixture.pool, fixture.issuer.URL, "alice"))
	require.NoError(t, err)

	ciphertext := randomBytes(t, config.DefaultBlobMaxChunkBytes+1)

	otherID := randomBytes(t, 32)
	requireCode(t, connect.CodeInvalidArgument, fixture.upload(t, token, vaultID, otherID, ciphertext), "an id that is not the hash of the sealed bytes")
	_, err = fixture.download(t, token, vaultID, otherID, 0, 0)
	requireCode(t, connect.CodeNotFound, err, "nothing visible")

	blobID := blobIDOf(ciphertext)
	require.NoError(t, fixture.upload(t, token, vaultID, blobID, ciphertext))
	assert.Equal(t, ciphertext, fixture.downloadAll(t, token, vaultID, blobID))
}
