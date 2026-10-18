package blobstore_test

import (
	"bytes"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
)

func TestParseBlobKey(t *testing.T) {
	vaultID := uuid.MustParse("0192f0c4-7a3e-7c1b-9d2e-3f4a5b6c7d8e")
	blobID := bytes.Repeat([]byte{0xab}, 32)

	tests := []struct {
		name string
		key  string
		ok   bool
	}{
		{name: "blob key", key: blobstore.BlobKey(vaultID, blobID), ok: true},
		{name: "staged chunk", key: blobstore.ChunkKey(vaultID, uuid.New(), 0, uuid.New())},
		{name: "other prefix", key: "other/" + vaultID.String() + "/blobs/ab"},
		{name: "non-canonical vault id", key: "vaults/" + vaultID.URN() + "/blobs/ab"},
		{name: "upper-case hex", key: "vaults/" + vaultID.String() + "/blobs/AB"},
		{name: "odd hex", key: "vaults/" + vaultID.String() + "/blobs/abc"},
		{name: "empty blob id", key: "vaults/" + vaultID.String() + "/blobs/"},
		{name: "nested", key: "vaults/" + vaultID.String() + "/blobs/ab/cd"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotVault, gotBlob, ok := blobstore.ParseBlobKey(test.key)

			assert.Equal(t, test.ok, ok)

			if test.ok {
				assert.Equal(t, vaultID, gotVault)
				assert.Equal(t, blobID, gotBlob)
			}
		})
	}
}
