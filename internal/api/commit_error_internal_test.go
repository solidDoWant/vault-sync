package api

import (
	"fmt"
	"log/slog"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// The handler validates paths before the store sees them, so a path the
// store refuses can only reach commitError if the two disagree; it must
// still be the caller's error, never internal (issue #121).
func TestCommitErrorMapsStoreRefusalsToClientCodes(t *testing.T) {
	service := SyncService{Logger: slog.New(slog.DiscardHandler)}

	tests := []struct {
		err  error
		code connect.Code
	}{
		{err: store.ErrInvalidPath, code: connect.CodeInvalidArgument},
		{err: fmt.Errorf("commit: %w", store.ErrInvalidPath), code: connect.CodeInvalidArgument},
		{err: store.ErrPathNotCurrent, code: connect.CodeInvalidArgument},
		{err: store.ErrPathKeyTaken, code: connect.CodeAlreadyExists},
		{err: store.ErrIDInUse, code: connect.CodeInvalidArgument},
		// The caller lost write access after the request was authorized.
		{err: store.ErrVaultNotFound, code: connect.CodeNotFound},
		{err: store.ErrVaultDeleted, code: connect.CodeNotFound},
		{err: store.ErrReadOnlyMember, code: connect.CodePermissionDenied},
	}

	for _, test := range tests {
		t.Run(test.err.Error(), func(t *testing.T) {
			assert.Equal(t, test.code, connect.CodeOf(service.commitError(t.Context(), test.err)))
		})
	}
}
