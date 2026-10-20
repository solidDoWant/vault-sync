package api_test

import (
	"bytes"
	"compress/gzip"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
)

// Startup requires the send limit to be at least MinResponseLimitBytes, and
// every page holds at least one entry, so a response with one revision or
// one vault whose every field is at its largest must fit
// MinResponseLimitBytes in every encoding the server sends.
func TestOneRevisionResponsesFitTheMinimumLimit(t *testing.T) {
	id := strings.Repeat("f", 36)
	// Every byte of a path may be a multi-byte character; as protobuf
	// bytes the size only depends on the length.
	path := bytes.Repeat([]byte{0xff}, api.MaxPathBytes)
	revision := &vaultsyncv1.Revision{
		Id:          id,
		DocumentId:  id,
		VaultId:     id,
		Seq:         math.MaxUint64,
		ParentRevId: id,
		Kind:        vaultsyncv1.DocumentKind(math.MaxInt32),
		ContentRef:  &vaultsyncv1.ContentRef{BlobId: bytes.Repeat([]byte{0xff}, 32), Size: math.MaxUint64},
		Path:        path,
		Deleted:     true,
		DeviceId:    id,
		UserId:      id,
		CreateTime:  timestamppb.New(time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)),
	}

	responses := map[string]proto.Message{
		"ListChangesResponse": &vaultsyncv1.ListChangesResponse{
			Revisions: []*vaultsyncv1.Revision{revision},
			HasMore:   true,
			HeadSeq:   math.MaxUint64,
		},
		"GetDocumentHistoryResponse": &vaultsyncv1.GetDocumentHistoryResponse{
			Document: &vaultsyncv1.Document{
				Id:        id,
				VaultId:   id,
				Kind:      vaultsyncv1.DocumentKind(math.MaxInt32),
				HeadRevId: id,
			},
			Revisions: []*vaultsyncv1.Revision{revision},
			// Tokens are 11 characters; leave ample room.
			NextPageToken: strings.Repeat("A", 64),
			// The revision's device, with the name JSON expands most.
			DeviceNames: []*vaultsyncv1.DeviceName{{DeviceId: id, Name: strings.Repeat(`"`, api.MaxDeviceNameBytes)}},
		},
		"ListVaultsResponse": &vaultsyncv1.ListVaultsResponse{
			Vaults: []*vaultsyncv1.Vault{{
				Id: id,
				// A quote is the printable ASCII character JSON expands
				// most; multi-byte characters are no longer once encoded.
				Name:       strings.Repeat(`"`, api.MaxVaultNameBytes),
				Encryption: vaultsyncv1.VaultEncryption(math.MaxInt32),
				Escrow:     true,
				Role:       vaultsyncv1.VaultRole(math.MaxInt32),
				HeadSeq:    math.MaxUint64,
				CreateTime: timestamppb.New(time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)),
			}},
			// Tokens are 22 characters; leave ample room.
			NextPageToken: strings.Repeat("A", 64),
		},
	}

	for name, response := range responses {
		binary, err := proto.Marshal(response)
		require.NoError(t, err)

		json, err := protojson.Marshal(response)
		require.NoError(t, err)

		for encoding, encoded := range map[string][]byte{"binary": binary, "JSON": json} {
			assert.LessOrEqual(t, len(encoded), api.MinResponseLimitBytes, "%s, %s", name, encoding)
			assert.LessOrEqual(t, len(gzipped(t, encoded)), api.MinResponseLimitBytes, "%s, %s, gzip", name, encoding)
		}
	}
}

func gzipped(t *testing.T, data []byte) []byte {
	t.Helper()

	var buffer bytes.Buffer

	writer := gzip.NewWriter(&buffer)
	_, err := writer.Write(data)
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	return buffer.Bytes()
}
