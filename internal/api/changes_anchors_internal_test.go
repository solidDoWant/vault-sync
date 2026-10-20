package api

import (
	"math"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// The anchors a ListChanges request asks the store to check (SPEC.md §6.1,
// issues #155, #494): since_anchor at since_seq and own_commit_anchor at
// own_commit_seq, each only when well-formed.
func TestChangesAnchorsAreBounded(t *testing.T) {
	cursor, own := uuid.New(), uuid.New()

	invalid := func(t require.TestingT, err error, _ ...any) {
		require.Error(t, err)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}

	tests := []struct {
		name    string
		request *vaultsyncv1.ListChangesRequest
		want    []store.SeqAnchor
		wantErr require.ErrorAssertionFunc
	}{
		{name: "none", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 4}},
		{
			name:    "cursor only",
			request: &vaultsyncv1.ListChangesRequest{SinceSeq: 4, SinceAnchor: cursor[:]},
			want:    []store.SeqAnchor{{Seq: 4, Anchor: cursor}},
		},
		{
			name:    "own commit only",
			request: &vaultsyncv1.ListChangesRequest{SinceSeq: 4, OwnCommitSeq: 5, OwnCommitAnchor: own[:]},
			want:    []store.SeqAnchor{{Seq: 5, Anchor: own}},
		},
		{
			name:    "both",
			request: &vaultsyncv1.ListChangesRequest{SinceSeq: 4, SinceAnchor: cursor[:], OwnCommitSeq: 9, OwnCommitAnchor: own[:]},
			want:    []store.SeqAnchor{{Seq: 4, Anchor: cursor}, {Seq: 9, Anchor: own}},
		},
		{
			name:    "own commit at the highest seq",
			request: &vaultsyncv1.ListChangesRequest{OwnCommitSeq: math.MaxInt64, OwnCommitAnchor: own[:]},
			want:    []store.SeqAnchor{{Seq: math.MaxInt64, Anchor: own}},
		},
		{name: "own commit above the highest seq", request: &vaultsyncv1.ListChangesRequest{OwnCommitSeq: math.MaxInt64 + 1, OwnCommitAnchor: own[:]}, wantErr: invalid},
		{name: "own commit at the cursor", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 5, OwnCommitSeq: 5, OwnCommitAnchor: own[:]}, wantErr: invalid},
		{name: "own commit seq without anchor", request: &vaultsyncv1.ListChangesRequest{OwnCommitSeq: 5}, wantErr: invalid},
		{name: "own commit anchor without seq", request: &vaultsyncv1.ListChangesRequest{OwnCommitAnchor: own[:]}, wantErr: invalid},
		{name: "own commit anchor of 15 bytes", request: &vaultsyncv1.ListChangesRequest{OwnCommitSeq: 5, OwnCommitAnchor: own[:15]}, wantErr: invalid},
		{name: "own commit anchor of 17 bytes", request: &vaultsyncv1.ListChangesRequest{OwnCommitSeq: 5, OwnCommitAnchor: append(own[:], 0)}, wantErr: invalid},
		{name: "cursor anchor of 15 bytes", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 4, SinceAnchor: cursor[:15]}, wantErr: invalid},
		{name: "cursor anchor at seq 0", request: &vaultsyncv1.ListChangesRequest{SinceAnchor: cursor[:]}, wantErr: invalid},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.wantErr == nil {
				test.wantErr = require.NoError
			}

			anchors, err := changesAnchors(test.request)
			test.wantErr(t, err)
			assert.Equal(t, test.want, anchors)
		})
	}
}
