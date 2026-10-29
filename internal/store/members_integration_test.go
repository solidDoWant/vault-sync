//go:build integration

package store_test

import (
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// awaitBlockedBy returns once some PostgreSQL backend waits for a lock that
// the backend pid holds. The poll delay only spaces the polls.
func awaitBlockedBy(t *testing.T, pool *pgxpool.Pool, pid uint32) {
	t.Helper()

	backoff := time.Millisecond

	for {
		var waiting bool
		require.NoError(t, pool.QueryRow(t.Context(),
			`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid)))`,
			int64(pid)).Scan(&waiting))

		if waiting {
			return
		}

		timer := time.NewTimer(backoff)

		select {
		case <-t.Context().Done():
			timer.Stop()
			require.FailNow(t, "the test ended before a backend waited for the lock")
		case <-timer.C:
		}

		backoff = min(2*backoff, 50*time.Millisecond)
	}
}

// TestRedeemInvitationLocksTheVaultBeforeTheInvitation holds a vault's row
// lock the way CreateInvitation does, starts a redemption of one of its
// invitations, and once the redemption waits, lets the invitation expire and
// prunes the vault's expired invitations in the lock holder — what
// CreateInvitation does when an invitation expires mid-redemption. If the
// redemption had locked the invitation before the vault, the prune and the
// redemption would wait on each other and PostgreSQL would abort one with a
// deadlock. Instead the prune completes and the redemption finds no
// invitation.
func TestRedeemInvitationLocksTheVaultBeforeTheInvitation(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	guest, err := queries.UpsertUser(t.Context(), testIssuer, "guest", "")
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Shared", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	codeHash := []byte("about-to-expire-code-hash-000000")
	_, err = queries.InVault(vault.ID).CreateInvitation(t.Context(), owner, uuid.Nil, store.RoleEditor, codeHash, time.Hour, 10, nil)
	require.NoError(t, err)

	holder, err := pool.Acquire(t.Context())
	require.NoError(t, err)
	t.Cleanup(holder.Release)

	tx, err := holder.Begin(t.Context())
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(t.Context()) })

	_, err = tx.Exec(t.Context(), `SELECT head_seq FROM vaults WHERE id = $1 FOR NO KEY UPDATE`, vault.ID)
	require.NoError(t, err)

	var redeemErr error

	var group sync.WaitGroup

	group.Go(func() {
		_, redeemErr = queries.RedeemInvitation(t.Context(), guest, codeHash, 10, nil)
	})

	awaitBlockedBy(t, pool, holder.Conn().PgConn().PID())

	// The invitation expires while the redemption waits, and the lock
	// holder prunes it as CreateInvitation does.
	_, err = tx.Exec(t.Context(), `UPDATE vault_invitations SET expires_at = now() WHERE vault_id = $1`, vault.ID)
	require.NoError(t, err)

	tag, err := tx.Exec(t.Context(), `DELETE FROM vault_invitations WHERE vault_id = $1 AND expires_at <= now()`, vault.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 1, tag.RowsAffected())
	require.NoError(t, tx.Commit(t.Context()))

	group.Wait()
	require.ErrorIs(t, redeemErr, store.ErrInvitationNotFound)

	role, err := queries.VaultRole(t.Context(), vault.ID, guest)
	require.ErrorIs(t, err, store.ErrVaultNotFound)
	assert.Empty(t, role)
}

// TestConcurrentRedemptionsOfOneCodeAdmitOneMember races several users
// redeeming the same invitation code: exactly one joins, every other
// redemption finds no invitation, and none fails otherwise.
func TestConcurrentRedemptionsOfOneCodeAdmitOneMember(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	const racers = 8

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Shared", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	codeHash := []byte("contended-code-hash-000000000000")
	_, err = queries.InVault(vault.ID).CreateInvitation(t.Context(), owner, uuid.Nil, store.RoleViewer, codeHash, time.Hour, 10, nil)
	require.NoError(t, err)

	users := make([]uuid.UUID, racers)

	for racer := range racers {
		users[racer], err = queries.UpsertUser(t.Context(), testIssuer, uuid.NewString(), "")
		require.NoError(t, err)
	}

	errs := make([]error, racers)
	start := make(chan struct{})

	var group sync.WaitGroup

	for racer := range racers {
		group.Go(func() {
			<-start

			_, errs[racer] = queries.RedeemInvitation(t.Context(), users[racer], codeHash, racers+1, nil)
		})
	}

	close(start)
	group.Wait()

	joined := 0

	for racer, redeemErr := range errs {
		requireNoLockConflict(t, redeemErr, "racer %d", racer)

		if redeemErr == nil {
			joined++

			role, err := queries.VaultRole(t.Context(), vault.ID, users[racer])
			require.NoError(t, err)
			assert.Equal(t, store.RoleViewer, role)

			continue
		}

		require.ErrorIs(t, redeemErr, store.ErrInvitationNotFound, "racer %d", racer)
	}

	assert.Equal(t, 1, joined)
}
