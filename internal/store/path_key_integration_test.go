//go:build integration

package store_test

import (
	"crypto/rand"
	"crypto/sha256"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// storeColumnBytes is the largest path and path_key the schema accepts
// (SPEC.md §5): case folding can expand a 4096-byte path to twice its size.
const storeColumnBytes = 8192

// randomKey returns length random lower-case ASCII letters, which PostgreSQL
// cannot compress meaningfully.
func randomKey(t *testing.T, length int) string {
	t.Helper()

	random := make([]byte, length)
	_, err := rand.Read(random)
	require.NoError(t, err)

	letters := make([]byte, length)
	for index, value := range random {
		letters[index] = 'a' + value%26
	}

	return string(letters)
}

// commitFixture is a plaintext vault with one device and one complete blob.
type commitFixture struct {
	pool    *pgxpool.Pool
	vault   *store.VaultStore
	user    uuid.UUID
	device  uuid.UUID
	content []byte
}

func newCommitFixture(t *testing.T) *commitFixture {
	t.Helper()

	pool := migratedPool(t)
	queries := store.New(pool)

	user, err := queries.UpsertUser(t.Context(), testIssuer, "alice", "")
	require.NoError(t, err)

	device, err := queries.RegisterDevice(t.Context(), user, "laptop", nil, 10)
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), user, store.NewVault{Name: "Notes", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	content := sha256.Sum256([]byte("content"))
	_, err = pool.Exec(t.Context(), "INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 7, 'complete')", vault.ID, content[:])
	require.NoError(t, err)

	return &commitFixture{pool: pool, vault: queries.InVault(vault.ID), user: user, device: device.ID, content: content[:]}
}

// create returns a revision creating a new document.
func (fixture *commitFixture) create(path, pathKey string) store.NewRevision {
	return store.NewRevision{
		ID:          uuid.Must(uuid.NewV7()),
		DocumentID:  uuid.Must(uuid.NewV7()),
		Kind:        "text",
		ContentRef:  fixture.content,
		ContentSize: 7,
		Path:        path,
		PathKey:     pathKey,
		DeviceID:    fixture.device,
		UserID:      fixture.user,
	}
}

func (fixture *commitFixture) headSeq(t *testing.T) int64 {
	t.Helper()

	var headSeq int64
	require.NoError(t, fixture.pool.QueryRow(t.Context(), "SELECT head_seq FROM vaults WHERE id = $1", fixture.vault.VaultID()).Scan(&headSeq))

	return headSeq
}

// Issue #121: the live path_key index takes path keys of any size the schema
// allows, however they compress, and still enforces uniqueness.
func TestLivePathKeyIndexTakesMaximumLengthKeys(t *testing.T) {
	fixture := newCommitFixture(t)

	key := randomKey(t, storeColumnBytes)
	path := randomKey(t, storeColumnBytes)

	committed, err := fixture.vault.CommitRevision(t.Context(), fixture.create(path, key))
	require.NoError(t, err)
	assert.Equal(t, path, committed.Path)

	document, err := fixture.vault.Document(t.Context(), committed.DocumentID)
	require.NoError(t, err)
	assert.Equal(t, key, document.PathKey)

	// The same key, even under another path, is taken.
	before := fixture.headSeq(t)
	_, err = fixture.vault.CommitRevision(t.Context(), fixture.create("other.md", key))
	require.ErrorIs(t, err, store.ErrPathKeyTaken)
	assert.Equal(t, before, fixture.headSeq(t), "nothing is committed")

	// Keys that differ only in their first or last byte are distinct.
	for _, other := range []string{"_" + key[1:], key[:len(key)-1] + "_"} {
		_, err = fixture.vault.CommitRevision(t.Context(), fixture.create("other.md", other))
		require.NoError(t, err)
	}

	// A rename onto a taken maximum-length key is refused too.
	mover, err := fixture.vault.CommitRevision(t.Context(), fixture.create("mover.md", "mover.md"))
	require.NoError(t, err)

	rename := fixture.create("taken.md", key)
	rename.DocumentID = mover.DocumentID
	rename.BaseRevID = uuid.NullUUID{UUID: mover.ID, Valid: true}
	_, err = fixture.vault.CommitRevision(t.Context(), rename)
	require.ErrorIs(t, err, store.ErrPathKeyTaken)

	// Deleting the holder frees the key.
	tombstone := fixture.create(path, key)
	tombstone.DocumentID = committed.DocumentID
	tombstone.BaseRevID = uuid.NullUUID{UUID: committed.ID, Valid: true}
	tombstone.Deleted = true
	_, err = fixture.vault.CommitRevision(t.Context(), tombstone)
	require.NoError(t, err)

	rename.ID = uuid.Must(uuid.NewV7())
	_, err = fixture.vault.CommitRevision(t.Context(), rename)
	require.NoError(t, err)
}

// Issue #121: a path or path_key the schema refuses is ErrInvalidPath, never
// an unclassified (internal) error.
func TestCommitRejectsInvalidPathsAsInvalid(t *testing.T) {
	fixture := newCommitFixture(t)

	tests := []struct {
		name          string
		path, pathKey string
	}{
		{name: "path one byte over", path: randomKey(t, storeColumnBytes+1), pathKey: "a.md"},
		{name: "path_key one byte over", path: "a.md", pathKey: randomKey(t, storeColumnBytes+1)},
		{name: "both far over", path: randomKey(t, 4*storeColumnBytes), pathKey: randomKey(t, 4*storeColumnBytes)},
		{name: "empty path", path: "", pathKey: "a.md"},
		{name: "empty path_key", path: "a.md", pathKey: ""},
		{name: "NUL in path", path: "a\x00.md", pathKey: "a.md"},
		{name: "NUL in path_key", path: "a.md", pathKey: "a\x00.md"},
		{name: "invalid UTF-8 path", path: "a\xff.md", pathKey: "a.md"},
		{name: "invalid UTF-8 path_key", path: "a.md", pathKey: "a\xff.md"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := fixture.vault.CommitRevision(t.Context(), fixture.create(test.path, test.pathKey))
			require.ErrorIs(t, err, store.ErrInvalidPath)
		})
	}

	assert.Zero(t, fixture.headSeq(t), "nothing is committed")

	// The bound itself is accepted.
	_, err := fixture.vault.CommitRevision(t.Context(), fixture.create(randomKey(t, storeColumnBytes), randomKey(t, storeColumnBytes)))
	require.NoError(t, err)
}
