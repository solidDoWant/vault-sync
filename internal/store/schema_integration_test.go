//go:build integration

package store_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	uniqueViolation     = "23505"
	foreignKeyViolation = "23503"
	checkViolation      = "23514"
)

func newID() string {
	id := make([]byte, 16)
	_, _ = rand.Read(id)

	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

func blobID(content string) []byte {
	sum := sha256.Sum256([]byte(content))

	return sum[:]
}

// fixture is a minimal populated vault pair.
type fixture struct {
	user, device   string
	vault, vault2  string
	blob, blob2    []byte
	document, head string
	nextSeqByVault map[string]int64
}

func newFixture(t *testing.T, pool *pgxpool.Pool) *fixture {
	t.Helper()

	f := &fixture{
		user:           newID(),
		device:         newID(),
		vault:          newID(),
		vault2:         newID(),
		blob:           blobID("vault one"),
		blob2:          blobID("vault two"),
		nextSeqByVault: map[string]int64{},
	}

	err := pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		statements := []struct {
			sql  string
			args []any
		}{
			{"INSERT INTO users (id, oidc_issuer, oidc_subject) VALUES ($1, 'https://idp.example', $2)", []any{f.user, f.user}},
			{"INSERT INTO devices (id, user_id, name) VALUES ($1, $2, 'laptop')", []any{f.device, f.user}},
			{"INSERT INTO vaults (id, name, encryption) VALUES ($1, 'one', 'none'), ($2, 'two', 'none')", []any{f.vault, f.vault2}},
			{"INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'owner')", []any{f.vault, f.user}},
			{"INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 9, 'complete'), ($3, $4, 9, 'complete')", []any{f.vault, f.blob, f.vault2, f.blob2}},
		}
		for _, statement := range statements {
			if _, err := tx.Exec(t.Context(), statement.sql, statement.args...); err != nil {
				return err
			}
		}

		return nil
	})
	require.NoError(t, err)

	f.document, f.head = newID(), newID()
	require.NoError(t, f.createDocument(t.Context(), pool, f.vault, f.document, f.head, "note.md", false))

	return f
}

func (f *fixture) nextSeq(vault string) int64 {
	f.nextSeqByVault[vault]++

	return f.nextSeqByVault[vault]
}

// createDocument inserts a document and its first revision in one
// transaction, as the server does. A deleted document gets a tombstone head.
func (f *fixture) createDocument(ctx context.Context, pool *pgxpool.Pool, vault, document, revision, pathKey string, deleted bool) error {
	content := f.blob
	if vault == f.vault2 {
		content = f.blob2
	}

	if deleted {
		content = nil
	}

	seq := f.nextSeq(vault)

	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key, deleted) VALUES ($1, $2, 'text', $3, $4, $5)",
			document, vault, revision, pathKey, deleted)
		if err != nil {
			return err
		}

		_, err = tx.Exec(ctx, "INSERT INTO revisions (id, document_id, vault_id, seq, content_ref, path, deleted, device_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
			revision, document, vault, seq, content, pathKey, deleted, f.device)

		return err
	})
}

func requirePgError(t *testing.T, err error, code, constraint string) {
	t.Helper()

	var pgErr *pgconn.PgError
	require.True(t, errors.As(err, &pgErr), "expected a PostgreSQL error, got %v", err)
	assert.Equal(t, code, pgErr.Code, pgErr.Message)
	assert.Equal(t, constraint, pgErr.ConstraintName, pgErr.Message)
}

func TestSchemaConstraints(t *testing.T) {
	pool := migratedPool(t)
	f := newFixture(t, pool)

	type statement struct {
		sql  string
		args []any
	}

	// Each case's statements run in one transaction; deferred foreign keys
	// only fail at commit.
	cases := []struct {
		name       string
		statements func() []statement
		code       string
		constraint string
	}{
		{
			name: "duplicate OIDC identity",
			statements: func() []statement {
				return []statement{{"INSERT INTO users (id, oidc_issuer, oidc_subject) VALUES ($1, 'https://idp.example', $2)", []any{newID(), f.user}}}
			},
			code: uniqueViolation, constraint: "users_oidc_identity_key",
		},
		{
			name: "device of unknown user",
			statements: func() []statement {
				return []statement{{"INSERT INTO devices (id, user_id, name) VALUES ($1, $2, 'phone')", []any{newID(), newID()}}}
			},
			code: foreignKeyViolation, constraint: "devices_user_id_fkey",
		},
		{
			name: "device public key is not X25519-sized",
			statements: func() []statement {
				return []statement{{"INSERT INTO devices (id, user_id, name, public_key) VALUES ($1, $2, 'phone', $3)", []any{newID(), f.user, []byte{1, 2, 3}}}}
			},
			code: checkViolation, constraint: "devices_public_key_length",
		},
		{
			name: "unknown vault encryption",
			statements: func() []statement {
				return []statement{{"INSERT INTO vaults (id, name, encryption) VALUES ($1, 'x', 'rot13')", []any{newID()}}}
			},
			code: checkViolation, constraint: "vaults_encryption_valid",
		},
		{
			name: "escrow on a plaintext vault",
			statements: func() []statement {
				return []statement{{"INSERT INTO vaults (id, name, encryption, escrow) VALUES ($1, 'x', 'none', true)", []any{newID()}}}
			},
			code: checkViolation, constraint: "vaults_escrow_requires_e2ee",
		},
		{
			name: "negative head_seq",
			statements: func() []statement {
				return []statement{{"UPDATE vaults SET head_seq = -1 WHERE id = $1", []any{f.vault}}}
			},
			code: checkViolation, constraint: "vaults_head_seq_nonnegative",
		},
		{
			name: "unknown member role",
			statements: func() []statement {
				return []statement{{"INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'admin')", []any{f.vault2, f.user}}}
			},
			code: checkViolation, constraint: "vault_members_role_valid",
		},
		{
			name: "duplicate membership",
			statements: func() []statement {
				return []statement{{"INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'viewer')", []any{f.vault, f.user}}}
			},
			code: uniqueViolation, constraint: "vault_members_pkey",
		},
		{
			name: "membership of unknown vault",
			statements: func() []statement {
				return []statement{{"INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'viewer')", []any{newID(), f.user}}}
			},
			code: foreignKeyViolation, constraint: "vault_members_vault_id_fkey",
		},
		{
			name: "blob id is not 32 bytes",
			statements: func() []statement {
				return []statement{{"INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 1, 'complete')", []any{f.vault, []byte("short")}}}
			},
			code: checkViolation, constraint: "blobs_blob_id_length",
		},
		{
			name: "unknown blob state",
			statements: func() []statement {
				return []statement{{"INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 1, 'lost')", []any{f.vault, blobID("x")}}}
			},
			code: checkViolation, constraint: "blobs_state_valid",
		},
		{
			name: "negative blob size",
			statements: func() []statement {
				return []statement{{"INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, -1, 'uploading')", []any{f.vault, blobID("x")}}}
			},
			code: checkViolation, constraint: "blobs_size_nonnegative",
		},
		{
			name: "unknown document kind",
			statements: func() []statement {
				return []statement{{"UPDATE documents SET kind = 'directory' WHERE id = $1", []any{f.document}}}
			},
			code: checkViolation, constraint: "documents_kind_valid",
		},
		{
			name: "document without a head revision",
			statements: func() []statement {
				return []statement{{"INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key) VALUES ($1, $2, 'text', $3, 'orphan.md')", []any{newID(), f.vault, newID()}}}
			},
			code: foreignKeyViolation, constraint: "documents_head_rev_fkey",
		},
		{
			name: "head revision of another document",
			statements: func() []statement {
				return []statement{{"INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key) VALUES ($1, $2, 'text', $3, 'other.md')", []any{newID(), f.vault, f.head}}}
			},
			code: foreignKeyViolation, constraint: "documents_head_rev_fkey",
		},
		{
			name: "revision in another vault than its document",
			statements: func() []statement {
				return []statement{{"INSERT INTO revisions (id, document_id, vault_id, seq, content_ref, path, device_id) VALUES ($1, $2, $3, 100, $4, 'note.md', $5)", []any{newID(), f.document, f.vault2, f.blob2, f.device}}}
			},
			code: foreignKeyViolation, constraint: "revisions_document_fkey",
		},
		{
			name: "duplicate seq in a vault",
			statements: func() []statement {
				return []statement{{"INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, device_id) VALUES ($1, $2, $3, 1, $4, $5, 'note.md', $6)", []any{newID(), f.document, f.vault, f.head, f.blob, f.device}}}
			},
			code: uniqueViolation, constraint: "revisions_vault_id_seq_key",
		},
		{
			name: "non-positive seq",
			statements: func() []statement {
				return []statement{{"INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, device_id) VALUES ($1, $2, $3, 0, $4, $5, 'note.md', $6)", []any{newID(), f.document, f.vault, f.head, f.blob, f.device}}}
			},
			code: checkViolation, constraint: "revisions_seq_positive",
		},
		{
			name: "parent revision of another document",
			statements: func() []statement {
				otherDocument, otherHead := newID(), newID()

				return []statement{
					{"INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key) VALUES ($1, $2, 'text', $3, 'parent.md')", []any{otherDocument, f.vault, otherHead}},
					{"INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, device_id) VALUES ($1, $2, $3, 1000, $4, $5, 'parent.md', $6)", []any{otherHead, otherDocument, f.vault, f.head, f.blob, f.device}},
				}
			},
			code: foreignKeyViolation, constraint: "revisions_parent_fkey",
		},
		{
			name: "content blob from another vault",
			statements: func() []statement {
				return []statement{{"INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, device_id) VALUES ($1, $2, $3, 1001, $4, $5, 'note.md', $6)", []any{newID(), f.document, f.vault, f.head, f.blob2, f.device}}}
			},
			code: foreignKeyViolation, constraint: "revisions_content_fkey",
		},
		{
			name: "empty path",
			statements: func() []statement {
				return []statement{{"INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, device_id) VALUES ($1, $2, $3, 1003, $4, $5, '', $6)", []any{newID(), f.document, f.vault, f.head, f.blob, f.device}}}
			},
			code: checkViolation, constraint: "revisions_path_length",
		},
		{
			name: "referenced blob cannot be dropped",
			statements: func() []statement {
				return []statement{{"DELETE FROM blobs WHERE vault_id = $1 AND blob_id = $2", []any{f.vault, f.blob}}}
			},
			code: foreignKeyViolation, constraint: "revisions_content_fkey",
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
				for _, statement := range test.statements() {
					if _, err := tx.Exec(t.Context(), statement.sql, statement.args...); err != nil {
						return err
					}
				}

				return nil
			})
			requirePgError(t, err, test.code, test.constraint)
		})
	}

	t.Run("valid edit and tombstone revisions are accepted", func(t *testing.T) {
		edit, tombstone := newID(), newID()

		err := pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
			statements := []struct {
				sql  string
				args []any
			}{
				{"INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, device_id) VALUES ($1, $2, $3, 2000, $4, $5, 'note.md', $6)", []any{edit, f.document, f.vault, f.head, f.blob, f.device}},
				{"INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, path, deleted, device_id) VALUES ($1, $2, $3, 2001, $4, 'note.md', true, $5)", []any{tombstone, f.document, f.vault, edit, f.device}},
				{"UPDATE documents SET head_rev_id = $1, deleted = true WHERE id = $2", []any{tombstone, f.document}},
			}
			for _, statement := range statements {
				if _, err := tx.Exec(t.Context(), statement.sql, statement.args...); err != nil {
					return err
				}
			}

			return nil
		})
		require.NoError(t, err)
	})
}

func TestLivePathKeyIsUniquePerVault(t *testing.T) {
	pool := migratedPool(t)
	f := newFixture(t, pool)

	// The fixture's live document already holds "note.md" in f.vault.
	err := f.createDocument(t.Context(), pool, f.vault, newID(), newID(), "note.md", false)
	requirePgError(t, err, uniqueViolation, "documents_live_path_key_idx")

	// Another vault may use the same path_key.
	require.NoError(t, f.createDocument(t.Context(), pool, f.vault2, newID(), newID(), "note.md", false))

	// Deleted documents keep their path_key without blocking it: several
	// tombstones may share it, and a new live document may take it.
	require.NoError(t, f.createDocument(t.Context(), pool, f.vault, newID(), newID(), "note.md", true))
	require.NoError(t, f.createDocument(t.Context(), pool, f.vault, newID(), newID(), "note.md", true))

	_, err = pool.Exec(t.Context(), "UPDATE documents SET deleted = true WHERE id = $1", f.document)
	require.NoError(t, err)
	require.NoError(t, f.createDocument(t.Context(), pool, f.vault, newID(), newID(), "note.md", false))

	// Undeleting the old document would collide with the new live one.
	_, err = pool.Exec(t.Context(), "UPDATE documents SET deleted = false WHERE id = $1", f.document)
	requirePgError(t, err, uniqueViolation, "documents_live_path_key_idx")
}
