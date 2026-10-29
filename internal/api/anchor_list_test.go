package api_test

import (
	"log/slog"
	"math"
	"testing"

	"connectrpc.com/connect"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
)

// maxSealedAnchorList is the sealed size of 100000 anchors, written out from
// docs/design/crypto.md rather than taken from the implementation: suite
// byte (1), nonce (24), count (4), 100000 vault ids with genesis hashes
// (16 + 32 each) and the tag (16).
const maxSealedAnchorList = 1 + 24 + 4 + 100_000*(16+32) + 16

func TestPutAnchorListBoundsEveryInputBeforeTheStore(t *testing.T) {
	ctx := userKeyContext(t)

	tests := []struct {
		name     string
		version  uint64
		size     int
		accepted bool
	}{
		{name: "1-byte list", version: 1, size: 1, accepted: true},
		{name: "list at the bound", version: 1, size: maxSealedAnchorList, accepted: true},
		{name: "list one byte over the bound", version: 1, size: maxSealedAnchorList + 1},
		{name: "empty list", version: 1, size: 0},
		{name: "version 0", version: 0, size: 100},
		{name: "version 2^63 - 1", version: math.MaxInt64, size: 100, accepted: true},
		{name: "version 2^63", version: math.MaxInt64 + 1, size: 100},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := &userKeyRecorder{}
			service := api.UserKeyService{Store: recorder, Logger: slog.New(slog.DiscardHandler)}

			_, err := service.PutAnchorList(ctx, connect.NewRequest(&vaultsyncv1.PutAnchorListRequest{
				Version: test.version, SealedList: make([]byte, test.size),
			}))
			assertBounded(t, recorder, err, test.accepted)
		})
	}
}
