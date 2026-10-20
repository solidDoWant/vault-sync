//go:build integration

package server_test

import (
	"math"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
)

// binaryBlobClient is a Connect client in the binary protobuf codec, the
// one the plugin uses.
func (fixture *blobFixture) binaryBlobClient() vaultsyncv1connect.BlobServiceClient {
	return fixture.blobs()
}

// jsonBlobClient is a Connect client in the JSON codec that neither asks for
// nor accepts compressed responses, so every message crosses the wire at its
// full base64-expanded size.
func (fixture *blobFixture) jsonBlobClient() vaultsyncv1connect.BlobServiceClient {
	plain := &http.Client{Transport: &http.Transport{DisableCompression: true}}

	return vaultsyncv1connect.NewBlobServiceClient(plain, fixture.running.apiURL(),
		connect.WithProtoJSON(), connect.WithAcceptCompression("gzip", nil, nil))
}

// Reproduction of #135: a JSON client downloading a maximum-size blob with
// the server-bounded default range was refused with RESOURCE_EXHAUSTED.
func TestJSONDownloadOfFullChunk(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")

	content := randomBytes(t, config.DefaultBlobMaxChunkBytes)
	blobID := blobIDOf(content)
	require.NoError(t, fixture.upload(t, token, vault.GetId(), blobID, content))

	client := fixture.jsonBlobClient()

	var downloaded []byte

	for uint64(len(downloaded)) < uint64(len(content)) {
		response, err := client.DownloadBlob(t.Context(), authorized(&vaultsyncv1.DownloadBlobRequest{
			VaultId: vault.GetId(), BlobId: blobID, Offset: uint64(len(downloaded)),
		}, token))
		require.NoError(t, err)
		require.NotEmpty(t, response.Msg.GetData(), "download made no progress")

		downloaded = append(downloaded, response.Msg.GetData()...)
	}

	require.Equal(t, content, downloaded)
}

// Reproduction of #135: a JSON client uploading a chunk of the advertised
// maximum size was refused with 413. The client now follows the
// max_chunk_size its own BeginBlob returned.
func TestJSONUploadOfFullChunk(t *testing.T) {
	fixture := newBlobFixture(t, defaultBlobLimits)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")

	content := randomBytes(t, config.DefaultBlobMaxChunkBytes)
	blobID := blobIDOf(content)
	client := fixture.jsonBlobClient()

	begun, err := client.BeginBlob(t.Context(), authorized(&vaultsyncv1.BeginBlobRequest{
		VaultId: vault.GetId(), BlobId: blobID, Size: uint64(len(content)),
	}, token))
	require.NoError(t, err)
	// The size docs/configuration.md documents for the defaults.
	require.EqualValues(t, 784878, begun.Msg.GetMaxChunkSize())

	chunk := content[:min(len(content), int(begun.Msg.GetMaxChunkSize()))]
	_, err = client.PutBlobChunk(t.Context(), authorized(&vaultsyncv1.PutBlobChunkRequest{
		VaultId: vault.GetId(), BlobId: blobID, Data: chunk,
	}, token))
	require.NoError(t, err)
}

// A client in either codec that uploads in chunks of the max_chunk_size its
// BeginBlob returned, and downloads with the server-bounded default (or an
// oversized) range, always succeeds. Binary clients keep the configured
// maximum; JSON clients get a smaller one whose base64 encoding fits the
// request and send limit.
func TestBlobChunkLimitsHoldInEveryCodec(t *testing.T) {
	tests := []struct {
		name            string
		maxRequestBytes int64
		limits          api.BlobLimits
	}{
		{
			name:            "default limits",
			maxRequestBytes: config.DefaultMaxRequestBytes,
			limits:          defaultBlobLimits,
		},
		{
			// The smallest chunk limit with the smallest request limit
			// startup accepts for it: base64 then fits less than the
			// minimum chunk in a request.
			name:            "smallest limits",
			maxRequestBytes: blobstore.MinChunkBytes + config.ChunkRequestOverheadBytes,
			limits: api.BlobLimits{
				MaxChunkBytes:      blobstore.MinChunkBytes,
				MaxBlobBytes:       config.DefaultBlobMaxSizeBytes,
				MaxUploadsPerVault: config.DefaultBlobMaxUploadsPerVault,
			},
		},
	}

	codecs := []struct {
		name   string
		json   bool
		client func(*blobFixture) vaultsyncv1connect.BlobServiceClient
	}{
		{name: "binary", client: (*blobFixture).binaryBlobClient},
		{name: "json", json: true, client: (*blobFixture).jsonBlobClient},
	}

	for _, test := range tests {
		fixture := newBlobFixtureWithRequestLimit(t, test.limits, test.maxRequestBytes)
		token := fixture.token(t, "alice")
		maxChunk := int(test.limits.MaxChunkBytes)

		for _, codec := range codecs {
			t.Run(test.name+"/"+codec.name, func(t *testing.T) {
				vault := fixture.createVault(t, token, "Notes")
				client := codec.client(fixture)

				content := randomBytes(t, 2*maxChunk+1000)
				blobID := blobIDOf(content)

				begun, err := client.BeginBlob(t.Context(), authorized(&vaultsyncv1.BeginBlobRequest{
					VaultId: vault.GetId(), BlobId: blobID, Size: uint64(len(content)),
				}, token))
				require.NoError(t, err)

				advertised := int(begun.Msg.GetMaxChunkSize())
				if codec.json {
					// base64 makes four bytes of every three, so a
					// maximum-size chunk cannot fit; most of the limit
					// is still used.
					assert.Less(t, advertised, maxChunk)
					assert.Greater(t, advertised, int(test.maxRequestBytes)*3/4-2*config.ChunkRequestOverheadBytes)
				} else {
					assert.Equal(t, maxChunk, advertised)
				}

				for offset := 0; offset < len(content); {
					end := min(offset+advertised, len(content))

					response, err := client.PutBlobChunk(t.Context(), authorized(&vaultsyncv1.PutBlobChunkRequest{
						VaultId: vault.GetId(), BlobId: blobID, Offset: uint64(offset), Data: content[offset:end],
					}, token))
					require.NoError(t, err, "chunk at %d", offset)
					require.EqualValues(t, end, response.Msg.GetReceivedSize())

					offset = end
				}

				committed, err := client.CommitBlob(t.Context(), authorized(&vaultsyncv1.CommitBlobRequest{
					VaultId: vault.GetId(), BlobId: blobID,
				}, token))
				require.NoError(t, err)
				require.EqualValues(t, len(content), committed.Msg.GetSize())

				for _, length := range []uint32{0, math.MaxUint32} {
					var downloaded []byte

					for len(downloaded) < len(content) {
						response, err := client.DownloadBlob(t.Context(), authorized(&vaultsyncv1.DownloadBlobRequest{
							VaultId: vault.GetId(), BlobId: blobID, Offset: uint64(len(downloaded)), Length: length,
						}, token))
						require.NoError(t, err, "range at %d, length %d", len(downloaded), length)

						data := response.Msg.GetData()
						require.NotEmpty(t, data, "download made no progress")

						if !codec.json && len(downloaded)+len(data) < len(content) {
							assert.Len(t, data, maxChunk, "binary ranges are the configured maximum")
						}

						downloaded = append(downloaded, data...)
					}

					require.Equal(t, content, downloaded, "length %d", length)
				}
			})
		}
	}
}

// #161: a client accepting gzip downloads incompressible content (as E2EE
// content is) in full ranges, in either codec, even when the chunk limit
// leaves only the smallest slack below the request and send limit, where
// gzip's framing makes a compressed response larger than its message.
func TestGzipDownloadsOfIncompressibleRangesFitTheSendLimit(t *testing.T) {
	const maxRequestBytes = config.MaxMaxRequestBytes

	limits := api.BlobLimits{
		MaxChunkBytes:      maxRequestBytes - config.ChunkRequestOverheadBytes,
		MaxBlobBytes:       config.DefaultBlobMaxSizeBytes,
		MaxUploadsPerVault: config.DefaultBlobMaxUploadsPerVault,
	}

	fixture := newBlobFixtureWithRequestLimit(t, limits, maxRequestBytes)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")

	content := randomBytes(t, int(limits.MaxChunkBytes))
	blobID := blobIDOf(content)
	require.NoError(t, fixture.upload(t, token, vault.GetId(), blobID, content))

	// Both clients ask for gzip (Connect clients do by default) and get it.
	gzipped := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	clients := map[string]vaultsyncv1connect.BlobServiceClient{
		"binary": vaultsyncv1connect.NewBlobServiceClient(gzipped, fixture.running.apiURL()),
		"json":   vaultsyncv1connect.NewBlobServiceClient(gzipped, fixture.running.apiURL(), connect.WithProtoJSON()),
	}

	for name, client := range clients {
		t.Run(name, func(t *testing.T) {
			var downloaded []byte

			for len(downloaded) < len(content) {
				response, err := client.DownloadBlob(t.Context(), authorized(&vaultsyncv1.DownloadBlobRequest{
					VaultId: vault.GetId(), BlobId: blobID, Offset: uint64(len(downloaded)), Length: math.MaxUint32,
				}, token))
				require.NoError(t, err, "range at %d", len(downloaded))
				require.NotEmpty(t, response.Msg.GetData(), "download made no progress")

				downloaded = append(downloaded, response.Msg.GetData()...)
			}

			require.Equal(t, content, downloaded)
		})
	}
}
