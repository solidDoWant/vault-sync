//go:build integration

package store_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// A commit authorized before an owner removes its user, demotes them to
// viewer or deletes the vault, but which takes the vault row lock only after
// that change committed, is refused and writes nothing. The test holds the
// vault row lock the way membership changes and DeleteVault do, starts an
// editor's commit, and once the commit waits for the lock, makes the change
// in the lock holder and commits it.
func TestCommitRechecksMembershipUnderTheVaultLock(t *testing.T) {
	tests := []struct {
		name      string
		change    string
		assertion require.ErrorAssertionFunc
	}{
		{
			name:   "role kept",
			change: `UPDATE vault_members SET role = 'editor' WHERE vault_id = $1 AND user_id = $2`,
		},
		{
			name:   "removed",
			change: `DELETE FROM vault_members WHERE vault_id = $1 AND user_id = $2`,
			assertion: func(t require.TestingT, err error, msgAndArgs ...any) {
				require.ErrorIs(t, err, store.ErrVaultNotFound, msgAndArgs...)
			},
		},
		{
			name:   "demoted to viewer",
			change: `UPDATE vault_members SET role = 'viewer' WHERE vault_id = $1 AND user_id = $2`,
			assertion: func(t require.TestingT, err error, msgAndArgs ...any) {
				require.ErrorIs(t, err, store.ErrReadOnlyMember, msgAndArgs...)
			},
		},
		{
			name:   "vault deleted",
			change: `UPDATE vaults SET deleted_at = now() WHERE id = $1 AND $2::uuid IS NOT NULL`,
			assertion: func(t require.TestingT, err error, msgAndArgs ...any) {
				require.ErrorIs(t, err, store.ErrVaultDeleted, msgAndArgs...)
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCommitFixture(t)
			queries := store.New(fixture.pool)
			vaultID := fixture.vault.VaultID()

			editor, err := queries.UpsertUser(t.Context(), testIssuer, "bob", "")
			require.NoError(t, err)

			device, err := queries.RegisterDevice(t.Context(), editor, "phone", nil, 10)
			require.NoError(t, err)

			_, err = fixture.pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'editor')`, vaultID, editor)
			require.NoError(t, err)

			revision := fixture.create("bob.md", "bob.md")
			revision.UserID = editor
			revision.DeviceID = device.ID

			before := fixture.headSeq(t)

			holder, err := fixture.pool.Begin(t.Context())
			require.NoError(t, err)

			defer func() { _ = holder.Rollback(t.Context()) }()

			_, err = holder.Exec(t.Context(), `SELECT 1 FROM vaults WHERE id = $1 FOR NO KEY UPDATE`, vaultID)
			require.NoError(t, err)

			committed := make(chan error, 1)

			go func() {
				_, err := fixture.vault.CommitRevision(t.Context(), revision)
				committed <- err
			}()

			awaitBlockedBy(t, fixture.pool, holder.Conn().PgConn().PID())

			_, err = holder.Exec(t.Context(), test.change, vaultID, editor)
			require.NoError(t, err)
			require.NoError(t, holder.Commit(t.Context()))

			err = <-committed

			assertion := test.assertion
			if assertion == nil {
				assertion = require.NoError
			}

			assertion(t, err)

			if err != nil {
				assert.Equal(t, before, fixture.headSeq(t), "nothing is committed")
			} else {
				assert.Equal(t, before+1, fixture.headSeq(t))
			}
		})
	}
}
