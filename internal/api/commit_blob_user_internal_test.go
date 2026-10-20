package api

import (
	"bytes"
	"log/slog"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Every production path authenticates the caller before CommitBlob runs, so
// a commit without a user is a wiring bug. It fails with INTERNAL before it
// touches the database or the object store, rather than composing under a
// compose-slot owner shared by every such caller (#388, #443).
func TestCommitBlobWithoutAnAuthenticatedUserIsInternal(t *testing.T) {
	logs := &bytes.Buffer{}

	// A zero Store and no object store: any database or S3 access would
	// panic.
	service := BlobService{Store: &store.Store{}, Logger: slog.New(slog.NewJSONHandler(logs, nil))}

	ctx := authz.WithMembership(t.Context(), authz.Membership{VaultID: uuid.New(), Role: store.RoleEditor})
	request := connect.NewRequest(&vaultsyncv1.CommitBlobRequest{BlobId: make([]byte, BlobIDBytes)})

	response, err := service.CommitBlob(ctx, request)
	require.Error(t, err)
	assert.Nil(t, response)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	assert.Contains(t, logs.String(), "blob commit reached without an authenticated user")
}
