//go:build integration

package store_test

import (
	"crypto/sha256"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// successor returns a revision on top of head, keeping its document.
func (fixture *commitFixture) successor(head store.Revision, path, pathKey string, deleted bool) store.NewRevision {
	revision := fixture.create(path, pathKey)
	revision.DocumentID = head.DocumentID
	revision.BaseRevID = uuid.NullUUID{UUID: head.ID, Valid: true}
	revision.Deleted = deleted

	return revision
}

// Issue #134: the folders of a path key are its proper prefixes ending
// before a "/", counted in characters, not bytes.
func TestPathKeyFolders(t *testing.T) {
	pool := migratedPool(t)

	tests := []struct {
		pathKey string
		want    []string
	}{
		{pathKey: "a.md", want: []string{}},
		{pathKey: "notes/c.md", want: []string{"notes"}},
		{pathKey: "a/b/c/d.md", want: []string{"a", "a/b", "a/b/c"}},
		{pathKey: "é/straße/x", want: []string{"é", "é/straße"}},
		{pathKey: "日本/語/ノート.md", want: []string{"日本", "日本/語"}},
		{pathKey: `a\b/c`, want: []string{`a\b`}},
		{pathKey: "a.b/c d/e", want: []string{"a.b", "a.b/c d"}},
	}

	for _, test := range tests {
		t.Run(test.pathKey, func(t *testing.T) {
			var folders []string
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT documents_path_key_folders($1)`, test.pathKey).Scan(&folders))
			assert.Equal(t, test.want, folders)
		})
	}
}

// Issue #134: both directions of the file/folder check are index probes, not
// scans of the vault's documents, whether the vault is large or one of many
// small ones.
func TestPathFolderCheckUsesIndexes(t *testing.T) {
	fixture := newCommitFixture(t)

	shapes := []struct {
		name string
		// populate fills the documents table; $1, where used, is the
		// fixture's vault ("many small vaults" includes it).
		populate []string
		// folderDigestsOnly limits the shape to the probe that computes
		// folder digests per row.
		folderDigestsOnly bool
	}{
		{
			// Where a scan looks cheapest. For the path key digest
			// probe it is (one hash per row of a tiny table), but a
			// scan would recompute every row's folder digests, which
			// takes tens of milliseconds for a deep key.
			name:              "a few documents",
			folderDigestsOnly: true,
			populate: []string{`
				INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key)
				SELECT gen_random_uuid(), $1, 'text', gen_random_uuid(), 'folder1/note' || i || '.md'
				FROM generate_series(1, 3) AS i`},
		},
		{
			name: "one large vault",
			populate: []string{`
				INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key, deleted)
				SELECT gen_random_uuid(), $1, 'text', gen_random_uuid(),
					'folder' || (i % 50) || '/sub' || (i % 7) || '/note' || i || '.md', i % 10 = 0
				FROM generate_series(1, 20000) AS i`},
		},
		{
			name: "many small vaults",
			populate: []string{
				`INSERT INTO vaults (id, name, encryption) SELECT gen_random_uuid(), 'other', 'none' FROM generate_series(1, 399)`,
				`INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key, deleted)
				SELECT gen_random_uuid(), vaults.id, 'text', gen_random_uuid(),
					'folder' || (i % 5) || '/note' || i || '.md', i % 10 = 0
				FROM vaults CROSS JOIN generate_series(1, 50) AS i`,
			},
		},
	}

	probes := []struct {
		name, query, index string
	}{
		{name: "a folder of the key is a live key", query: store.FolderIsLiveQuery, index: "documents_live_path_key_idx"},
		{name: "the key is a folder of a live key", query: store.IsLiveFolderQuery, index: "documents_live_folder_idx"},
	}

	for _, shape := range shapes {
		for _, probe := range probes {
			if shape.folderDigestsOnly && probe.query != store.IsLiveFolderQuery {
				continue
			}

			t.Run(shape.name+"/"+probe.name, func(t *testing.T) {
				// Rolled back, so the documents need no revisions
				// (their foreign key is deferred). ANALYZE counts the
				// transaction's own rows.
				err := pgx.BeginFunc(t.Context(), fixture.pool, func(tx pgx.Tx) error {
					for _, statement := range shape.populate {
						var arguments []any
						if strings.Contains(statement, "$1") {
							arguments = append(arguments, fixture.vault.VaultID())
						}

						if _, err := tx.Exec(t.Context(), statement, arguments...); err != nil {
							return err
						}
					}

					if _, err := tx.Exec(t.Context(), `ANALYZE documents`); err != nil {
						return err
					}

					// A key with no collision: the check's common
					// case, which must not read the vault's documents.
					rows, err := tx.Query(t.Context(), `EXPLAIN `+probe.query, fixture.vault.VaultID(), "folder1/sub1/new")
					if err != nil {
						return err
					}

					lines, err := pgx.CollectRows(rows, pgx.RowTo[string])
					if err != nil {
						return err
					}

					plan := strings.Join(lines, "\n")
					assert.Contains(t, plan, probe.index, plan)
					assert.NotContains(t, plan, "Seq Scan", plan)

					return errRollback
				})
				require.ErrorIs(t, err, errRollback)
			})
		}
	}
}

// errRollback rolls back a pgx.BeginFunc transaction that succeeded.
var errRollback = errors.New("roll back")

// Issue #134: the check holds for the deepest path keys the schema allows,
// one folder per two bytes (leaving room for a key under the deepest one).
func TestPathFolderCheckAtMaximumDepth(t *testing.T) {
	fixture := newCommitFixture(t)

	deepest := strings.Repeat("a/", storeColumnBytes/2-2) + "b"
	require.Len(t, deepest, storeColumnBytes-3)

	_, err := fixture.vault.CommitRevision(t.Context(), fixture.create("deep.md", deepest))
	require.NoError(t, err)

	tests := []struct {
		name, pathKey string
		assertion     require.ErrorAssertionFunc
	}{
		{name: "outermost folder", pathKey: "a", assertion: requireFolderTaken},
		{name: "innermost folder", pathKey: strings.Repeat("a/", storeColumnBytes/2-3) + "a", assertion: requireFolderTaken},
		{name: "under the deepest key", pathKey: deepest + "/c", assertion: requireFolderTaken},
		{name: "a sibling of the deepest key", pathKey: strings.Repeat("a/", storeColumnBytes/2-2) + "c"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			before := fixture.headSeq(t)
			_, err := fixture.vault.CommitRevision(t.Context(), fixture.create("other.md", test.pathKey))

			assertion := test.assertion
			if assertion == nil {
				assertion = require.NoError
			}

			assertion(t, err)

			if err != nil {
				assert.Equal(t, before, fixture.headSeq(t), "nothing is committed")
			}
		})
	}
}

func requireFolderTaken(t require.TestingT, err error, msgAndArgs ...any) {
	require.ErrorIs(t, err, store.ErrPathFolderTaken, msgAndArgs...)
}

// Issue #134: a file/folder collision committed before the check existed
// (simulated by inserting it behind the check's back) does not lock its
// documents: they can still be edited, deleted and moved apart, so no
// acknowledged write becomes stuck (SPEC.md §2, principle 1).
func TestPreexistingFileFolderCollisionStaysEditable(t *testing.T) {
	fixture := newCommitFixture(t)

	file, err := fixture.vault.CommitRevision(t.Context(), fixture.create("notes", "notes"))
	require.NoError(t, err)

	other, err := fixture.vault.CommitRevision(t.Context(), fixture.create("other.md", "other.md"))
	require.NoError(t, err)

	// Make other.md a child of notes without going through CommitRevision.
	_, err = fixture.pool.Exec(t.Context(), `UPDATE documents SET path_key = 'notes/c.md' WHERE id = $1`, other.DocumentID)
	require.NoError(t, err)

	edit, err := fixture.vault.CommitRevision(t.Context(), fixture.successor(file, "notes", "notes", false))
	require.NoError(t, err, "an edit that keeps the path key is not re-checked")

	_, err = fixture.vault.CommitRevision(t.Context(), fixture.successor(other, "other.md", "notes/c.md", true))
	require.NoError(t, err, "a delete is never refused")

	_, err = fixture.vault.CommitRevision(t.Context(), fixture.successor(edit, "notes", "notes", true))
	require.NoError(t, err)
}

// Issue #134 non-goal: an E2EE vault's path_key is an HMAC, not a path, so
// it is never compared by folder; a "/" in it means nothing.
func TestPathFolderCheckSkipsEndToEndEncryptedVaults(t *testing.T) {
	fixture := newCommitFixture(t)
	queries := store.New(fixture.pool)

	vault, err := queries.CreateVault(t.Context(), fixture.user, store.NewVault{Name: "Secret", Encryption: store.EncryptionE2EE}, 10)
	require.NoError(t, err)

	content := sha256.Sum256([]byte("content"))
	_, err = fixture.pool.Exec(t.Context(), "INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 7, 'complete')", vault.ID, content[:])
	require.NoError(t, err)

	encrypted := queries.InVault(vault.ID)

	for _, pathKey := range []string{"k", "k/l"} {
		_, err := encrypted.CommitRevision(t.Context(), fixture.create("ciphertext-"+pathKey, pathKey))
		require.NoError(t, err)
	}
}
