package config_test

import (
	"encoding/base64"
	"math"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/config"
)

// The startup check reserves ChunkRequestOverheadBytes of every request for
// the fields of a chunk upload besides its data, and the same for a download
// response, so a maximum-size chunk always fits the request (and send)
// limit. The reserve must cover the largest possible framing, in binary
// protobuf and, beside the data's base64 encoding, in JSON.
func TestChunkFramingFitsTheReservedOverhead(t *testing.T) {
	for _, chunkBytes := range []int{config.DefaultBlobMaxChunkBytes, config.MaxMaxRequestBytes} {
		data := make([]byte, chunkBytes)

		messages := map[string]proto.Message{
			"PutBlobChunkRequest": &vaultsyncv1.PutBlobChunkRequest{
				VaultId: strings.Repeat("f", 36),
				BlobId:  make([]byte, 32),
				Offset:  math.MaxUint64,
				Data:    data,
			},
			"DownloadBlobResponse": &vaultsyncv1.DownloadBlobResponse{Data: data, Size: math.MaxUint64},
		}

		for name, message := range messages {
			assert.LessOrEqual(t, proto.Size(message)-chunkBytes, config.ChunkRequestOverheadBytes,
				"%s framing with a %d-byte chunk", name, chunkBytes)

			encoded, err := protojson.Marshal(message)
			require.NoError(t, err)
			assert.LessOrEqual(t, len(encoded)-base64.StdEncoding.EncodedLen(chunkBytes), config.ChunkRequestOverheadBytes,
				"%s JSON framing with a %d-byte chunk", name, chunkBytes)
		}
	}
}
