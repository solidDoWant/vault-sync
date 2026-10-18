//go:build integration

package store_test

import (
	"crypto/sha256"
	"errors"
	"log/slog"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

func TestAllVaultsListsEveryVaultRegardlessOfMembership(t *testing.T) {
	queries := store.New(migratedPool(t))

	var want []uuid.UUID

	for _, subject := range []string{"alice", "bob", "carol"} {
		user, err := queries.UpsertUser(t.Context(), testIssuer, subject)
		require.NoError(t, err)

		vault, err := queries.CreateVault(t.Context(), user, store.NewVault{Name: subject + "'s", Encryption: store.EncryptionNone}, 10)
		require.NoError(t, err)

		want = append(want, vault.ID)
	}

	first, err := queries.AllVaults(t.Context(), uuid.Nil, 2)
	require.NoError(t, err)
	require.Len(t, first, 2)

	rest, err := queries.AllVaults(t.Context(), first[1].ID, 2)
	require.NoError(t, err)

	all := append(first, rest...)
	assert.Equal(t, want, vaultIDs(all), "every vault, in id order")
	assert.Equal(t, "alice's", all[0].Name)
	assert.Equal(t, store.EncryptionNone, all[0].Encryption)
	assert.Empty(t, all[0].Role)
}

// addBlob records a complete blob holding content in the fixture's vault.
func (fixture *commitFixture) addBlob(t *testing.T, content string) []byte {
	t.Helper()

	sum := sha256.Sum256([]byte(content))
	_, err := fixture.pool.Exec(t.Context(), "INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, $3, 'complete')",
		fixture.vault.VaultID(), sum[:], len(content))
	require.NoError(t, err)

	return sum[:]
}

func (fixture *commitFixture) commit(t *testing.T, revision store.NewRevision) store.Revision {
	t.Helper()

	committed, err := fixture.vault.CommitRevision(t.Context(), revision)
	require.NoError(t, err)

	return committed
}

// next returns a revision of committed's document with the given path and
// content, or a tombstone (keeping the fixture's content) if content is nil.
func (fixture *commitFixture) next(committed store.Revision, path string, content []byte, size int64) store.NewRevision {
	revision := fixture.create(path, path)
	revision.DocumentID = committed.DocumentID
	revision.BaseRevID = uuid.NullUUID{UUID: committed.ID, Valid: true}

	if content == nil {
		revision.Deleted = true

		return revision
	}

	revision.ContentRef = content
	revision.ContentSize = size

	return revision
}

func TestLiveDocumentsAtIsAPointInTimeView(t *testing.T) {
	fixture := newCommitFixture(t)
	edited := fixture.addBlob(t, "edited")

	created := fixture.commit(t, fixture.create("a.md", "a.md"))                          // seq 1
	renamed := fixture.commit(t, fixture.next(created, "renamed.md", fixture.content, 7)) // seq 2
	other := fixture.commit(t, fixture.create("b.md", "b.md"))                            // seq 3
	fixture.commit(t, fixture.next(other, "b.md", nil, 0))                                // seq 4: b deleted
	fixture.commit(t, fixture.next(renamed, "renamed.md", edited, 6))                     // seq 5

	type live struct {
		ID      uuid.UUID
		Path    string
		Content []byte
		Size    int64
	}

	tests := []struct {
		seq  int64
		want []live
	}{
		{seq: 0, want: nil},
		{seq: 1, want: []live{{created.DocumentID, "a.md", fixture.content, 7}}},
		{seq: 2, want: []live{{created.DocumentID, "renamed.md", fixture.content, 7}}},
		{seq: 3, want: []live{{created.DocumentID, "renamed.md", fixture.content, 7}, {other.DocumentID, "b.md", fixture.content, 7}}},
		{seq: 4, want: []live{{created.DocumentID, "renamed.md", fixture.content, 7}}},
		{seq: 5, want: []live{{created.DocumentID, "renamed.md", edited, 6}}},
	}

	for _, test := range tests {
		// One document per page, to exercise the cursor.
		var got []live

		after := uuid.Nil

		for {
			page, err := fixture.vault.LiveDocumentsAt(t.Context(), test.seq, after, 1)
			require.NoError(t, err)

			for _, document := range page {
				got = append(got, live{document.ID, document.Path, document.ContentRef, document.Size})
			}

			if len(page) < 1 {
				break
			}

			after = page[len(page)-1].ID
		}

		assert.Equal(t, test.want, got, "as of seq %d", test.seq)
	}

	// Another vault's documents never appear.
	queries := store.New(fixture.pool)
	otherVault, err := queries.CreateVault(t.Context(), fixture.user, store.NewVault{Name: "Other", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	documents, err := queries.InVault(otherVault.ID).LiveDocumentsAt(t.Context(), 5, uuid.Nil, 10)
	require.NoError(t, err)
	assert.Empty(t, documents)
}

func TestReadOnlyPoolRefusesWrites(t *testing.T) {
	cfg := testinfra.PostgresConfig(t)

	writable := openPool(t, cfg)
	_, err := store.Migrate(t.Context(), writable, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	cfg.ReadOnly = true
	readOnly := openPool(t, cfg)

	var count int
	require.NoError(t, readOnly.QueryRow(t.Context(), "SELECT count(*) FROM vaults").Scan(&count), "reads work")

	_, err = store.New(readOnly).UpsertUser(t.Context(), testIssuer, "alice")

	var pgErr *pgconn.PgError
	require.True(t, errors.As(err, &pgErr), "got %v", err)
	assert.Equal(t, "25006", pgErr.Code, "read_only_sql_transaction")

	require.NoError(t, readOnly.QueryRow(t.Context(), "SELECT count(*) FROM users").Scan(&count))
	assert.Zero(t, count)
}
