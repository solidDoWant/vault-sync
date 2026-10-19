//go:build sim

package sim_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"strconv"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// invariantFixture is a valid vault: document A with revisions a1 and a2,
// document B with revision b1, all acknowledged.
type invariantFixture struct {
	vault      uuid.UUID
	a, b       uuid.UUID
	a1, a2, b1 uuid.UUID
	device     uuid.UUID
	blob       []byte
	acked      []acknowledgement
}

func newInvariantFixture(t *testing.T, db *pgxpool.Pool) *invariantFixture {
	t.Helper()

	sum := sha256.Sum256([]byte("content"))
	fixture := &invariantFixture{
		vault: uuid.Must(uuid.NewV7()), a: uuid.Must(uuid.NewV7()), b: uuid.Must(uuid.NewV7()),
		a1: uuid.Must(uuid.NewV7()), a2: uuid.Must(uuid.NewV7()), b1: uuid.Must(uuid.NewV7()),
		device: uuid.Must(uuid.NewV7()), blob: sum[:],
	}
	user := uuid.Must(uuid.NewV7())

	revisions := []struct {
		id, document uuid.UUID
		parent       *uuid.UUID
		path         string
	}{
		{fixture.a1, fixture.a, nil, "a.md"},
		{fixture.a2, fixture.a, &fixture.a1, "a.md"},
		{fixture.b1, fixture.b, nil, "B.md"},
	}

	err := pgx.BeginFunc(t.Context(), db, func(tx pgx.Tx) error {
		statements := []struct {
			sql       string
			arguments []any
		}{
			{`INSERT INTO users (id, oidc_issuer, oidc_subject) VALUES ($1, 'issuer', $2)`, []any{user, user.String()}},
			{`INSERT INTO devices (id, user_id, name) VALUES ($1, $2, 'device')`, []any{fixture.device, user}},
			{`INSERT INTO vaults (id, name, encryption, head_seq) VALUES ($1, 'vault', 'none', 3)`, []any{fixture.vault}},
			{`INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 7, 'complete')`, []any{fixture.vault, fixture.blob}},
			{`INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key) VALUES ($1, $2, 'text', $3, 'a.md')`, []any{fixture.a, fixture.vault, fixture.a2}},
			{`INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key) VALUES ($1, $2, 'text', $3, 'b.md')`, []any{fixture.b, fixture.vault, fixture.b1}},
		}
		for _, statement := range statements {
			if _, err := tx.Exec(t.Context(), statement.sql, statement.arguments...); err != nil {
				return err
			}
		}

		for index, revision := range revisions {
			_, err := tx.Exec(t.Context(), `
				INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, device_id)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				revision.id, revision.document, fixture.vault, index+1, revision.parent, fixture.blob, revision.path, fixture.device)
			if err != nil {
				return err
			}

			parent := ""
			if revision.parent != nil {
				parent = revision.parent.String()
			}

			fixture.acked = append(fixture.acked, acknowledgement{
				RevisionID: revision.id.String(), DocumentID: revision.document.String(), Seq: strconv.Itoa(index + 1),
				ParentRevisionID: parent, Path: revision.path, BlobID: hex.EncodeToString(fixture.blob), Size: "7",
			})
		}

		return nil
	})
	require.NoError(t, err)

	return fixture
}

// TestInvariantChecksDetectEachViolation proves every invariant check has
// teeth: each corrupts a valid vault's database state in one way and
// expects the matching violation, while the valid state has none.
func TestInvariantChecksDetectEachViolation(t *testing.T) {
	database := testinfra.PostgresConfig(t)

	db, err := pgxpool.New(t.Context(), database.DSN)
	require.NoError(t, err)
	t.Cleanup(db.Close)

	_, err = store.Migrate(t.Context(), db, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)

	exec := func(t *testing.T, sql string, arguments ...any) {
		t.Helper()

		_, err := db.Exec(t.Context(), sql, arguments...)
		require.NoError(t, err)
	}

	tests := []struct {
		name string
		// corrupt breaks the fixture and returns the acknowledgements to
		// check.
		corrupt  func(t *testing.T, fixture *invariantFixture) []acknowledgement
		expected []string
	}{
		{
			name:    "valid state",
			corrupt: func(_ *testing.T, fixture *invariantFixture) []acknowledgement { return fixture.acked },
		},
		{
			name: "acknowledged revision missing from history",
			corrupt: func(_ *testing.T, fixture *invariantFixture) []acknowledgement {
				missing := fixture.acked[1]
				missing.RevisionID = uuid.Must(uuid.NewV7()).String()

				return append(fixture.acked, missing)
			},
			expected: []string{invariantHistory},
		},
		{
			name: "acknowledged revision stored differently",
			corrupt: func(_ *testing.T, fixture *invariantFixture) []acknowledgement {
				acked := append([]acknowledgement(nil), fixture.acked...)
				acked[1].Path = "elsewhere.md"

				return acked
			},
			expected: []string{invariantHistory},
		},
		{
			name: "gap in seq",
			corrupt: func(t *testing.T, fixture *invariantFixture) []acknowledgement {
				exec(t, `UPDATE revisions SET seq = 5 WHERE id = $1`, fixture.b1)
				exec(t, `UPDATE vaults SET head_seq = 5 WHERE id = $1`, fixture.vault)

				return nil
			},
			expected: []string{invariantSeq},
		},
		{
			name: "head_seq ahead of the revisions",
			corrupt: func(t *testing.T, fixture *invariantFixture) []acknowledgement {
				exec(t, `UPDATE vaults SET head_seq = 4 WHERE id = $1`, fixture.vault)

				return fixture.acked
			},
			expected: []string{invariantSeq},
		},
		{
			name: "two live documents share a path_key",
			corrupt: func(t *testing.T, fixture *invariantFixture) []acknowledgement {
				// The server's unique index would refuse this; the check must
				// not rely on it. The subtests share the database, so the
				// index comes back for the ones after this (#110).
				var definition string
				require.NoError(t, db.QueryRow(t.Context(), `SELECT pg_get_indexdef('documents_live_path_key_idx'::regclass)`).Scan(&definition))
				exec(t, `DROP INDEX documents_live_path_key_idx`)
				t.Cleanup(func() {
					ctx := context.WithoutCancel(t.Context())
					_, err := db.Exec(ctx, `UPDATE documents SET path_key = 'b.md' WHERE id = $1`, fixture.b)
					require.NoError(t, err)
					_, err = db.Exec(ctx, definition)
					require.NoError(t, err, "recreate the live path_key index")
				})
				exec(t, `UPDATE documents SET path_key = 'a.md' WHERE id = $1`, fixture.b)
				exec(t, `UPDATE revisions SET path = 'A.md' WHERE id = $1`, fixture.b1)

				return nil
			},
			expected: []string{invariantPathKey},
		},
		{
			name: "a live document's path_key is a folder of another's",
			corrupt: func(t *testing.T, fixture *invariantFixture) []acknowledgement {
				exec(t, `UPDATE documents SET path_key = 'a.md/b.md' WHERE id = $1`, fixture.b)
				exec(t, `UPDATE revisions SET path = 'A.md/b.md' WHERE id = $1`, fixture.b1)

				return nil
			},
			expected: []string{invariantPathFolder},
		},
		{
			name: "commit accepted against a stale base",
			corrupt: func(t *testing.T, fixture *invariantFixture) []acknowledgement {
				stale := uuid.Must(uuid.NewV7())
				exec(t, `INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, device_id)
					VALUES ($1, $2, $3, 4, $4, $5, 'a.md', $6)`, stale, fixture.a, fixture.vault, fixture.a1, fixture.blob, fixture.device)
				exec(t, `UPDATE documents SET head_rev_id = $1 WHERE id = $2`, stale, fixture.a)
				exec(t, `UPDATE vaults SET head_seq = 4 WHERE id = $1`, fixture.vault)

				return fixture.acked
			},
			expected: []string{invariantStaleBase},
		},
		{
			name: "commit without a base on an existing document",
			corrupt: func(t *testing.T, fixture *invariantFixture) []acknowledgement {
				root := uuid.Must(uuid.NewV7())
				exec(t, `INSERT INTO revisions (id, document_id, vault_id, seq, content_ref, path, device_id)
					VALUES ($1, $2, $3, 4, $4, 'B.md', $5)`, root, fixture.b, fixture.vault, fixture.blob, fixture.device)
				exec(t, `UPDATE documents SET head_rev_id = $1 WHERE id = $2`, root, fixture.b)
				exec(t, `UPDATE vaults SET head_seq = 4 WHERE id = $1`, fixture.vault)

				return fixture.acked
			},
			expected: []string{invariantStaleBase},
		},
		{
			name: "document does not mirror its head revision",
			corrupt: func(t *testing.T, fixture *invariantFixture) []acknowledgement {
				exec(t, `UPDATE documents SET head_rev_id = $1 WHERE id = $2`, fixture.a1, fixture.a)

				return fixture.acked
			},
			expected: []string{invariantDocumentHead},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newInvariantFixture(t, db)
			acked := test.corrupt(t, fixture)

			violations, err := checkInvariants(t.Context(), db, fixture.vault, acked, nil)
			require.NoError(t, err)

			assert.ElementsMatch(t, test.expected, invariantsOf(violations), "violations: %+v", violations)
		})
	}

	// No subtest leaves the shared database without the server's unique
	// live path_key index, so none depends on the order they run in.
	var indexed bool
	require.NoError(t, db.QueryRow(t.Context(), `SELECT to_regclass('documents_live_path_key_idx') IS NOT NULL`).Scan(&indexed))
	assert.True(t, indexed, "documents_live_path_key_idx was left dropped")
}

// TestInvariantChecksExcuseOnlyPurgedRevisions: a revision the run had
// retention purge, with the server's own purge, is not a lost write, its
// seq is not a gap and its child's new parent is not a stale base; the same
// state without the excuse still violates history and seq.
func TestInvariantChecksExcuseOnlyPurgedRevisions(t *testing.T) {
	database := testinfra.PostgresConfig(t)

	db, err := pgxpool.New(t.Context(), database.DSN)
	require.NoError(t, err)
	t.Cleanup(db.Close)

	_, err = store.Migrate(t.Context(), db, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)

	fixture := newInvariantFixture(t, db)

	purged, err := ageAndPurge(t.Context(), db, fixture.vault, []uuid.UUID{fixture.a1, fixture.a2})
	require.NoError(t, err)
	require.Equal(t, []purgedRevision{{ID: fixture.a1, Seq: 1}}, purged, "the older revision of the day is purged, the head kept")

	violations, err := checkInvariants(t.Context(), db, fixture.vault, fixture.acked, purged)
	require.NoError(t, err)
	assert.Empty(t, violations)

	violations, err = checkInvariants(t.Context(), db, fixture.vault, fixture.acked, nil)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{invariantHistory, invariantHistory, invariantSeq}, invariantsOf(violations), "violations: %+v", violations)
}
