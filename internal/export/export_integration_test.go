//go:build integration && linux

package export_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// deployment is a migrated database and a bucket, as a server leaves them.
type deployment struct {
	database store.Config
	bucket   blobstore.Config
	pool     *pgxpool.Pool
	store    *store.Store
	objects  *blobstore.Objects
	user     uuid.UUID
	device   uuid.UUID
}

func newDeployment(t *testing.T) *deployment {
	t.Helper()

	database := testinfra.PostgresConfig(t)
	bucket := testinfra.S3Bucket(t)

	pool, err := store.Open(t.Context(), database)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	objects, err := blobstore.New(bucket)
	require.NoError(t, err)

	queries := store.New(pool)

	user, err := queries.UpsertUser(t.Context(), "https://auth.example/", "alice", "")
	require.NoError(t, err)

	device, err := queries.RegisterDevice(t.Context(), user, "laptop", nil, 10)
	require.NoError(t, err)

	return &deployment{database: database, bucket: bucket, pool: pool, store: queries, objects: objects, user: user, device: device.ID}
}

func (deployment *deployment) env() map[string]string {
	return map[string]string{
		config.DatabaseURLEnv:           deployment.database.DSN,
		config.S3EndpointEnv:            deployment.bucket.Endpoint,
		config.S3RegionEnv:              deployment.bucket.Region,
		config.S3BucketEnv:              deployment.bucket.Bucket,
		config.S3AccessKeyIDFileEnv:     deployment.bucket.AccessKeyIDFile,
		config.S3SecretAccessKeyFileEnv: deployment.bucket.SecretAccessKeyFile,
		config.S3ForcePathStyleEnv:      "true",
	}
}

func (deployment *deployment) createVault(t *testing.T, name string, encryption store.Encryption) uuid.UUID {
	t.Helper()

	vault, err := deployment.store.CreateVault(t.Context(), deployment.user, store.NewVault{Name: name, Encryption: encryption}, 100)
	require.NoError(t, err)

	return vault.ID
}

// putBlob stores content as a complete blob of the vault, as CommitBlob
// leaves it, and returns its id.
func (deployment *deployment) putBlob(t *testing.T, vaultID uuid.UUID, content []byte) []byte {
	t.Helper()

	sum := sha256.Sum256(content)
	require.NoError(t, deployment.objects.Put(t.Context(), blobstore.BlobKey(vaultID, sum[:]), content))

	_, err := deployment.pool.Exec(t.Context(), `
		INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, $3, 'complete')
		ON CONFLICT DO NOTHING`, vaultID, sum[:], len(content))
	require.NoError(t, err)

	return sum[:]
}

// commit commits a revision of document (a new one if base is nil) and
// returns it. A nil content makes a tombstone.
func (deployment *deployment) commit(t *testing.T, vaultID, document uuid.UUID, base *store.Revision, path string, content []byte) store.Revision {
	t.Helper()

	deleted := content == nil
	if deleted {
		content = []byte("tombstone")
	}

	revision := store.NewRevision{
		ID:          uuid.Must(uuid.NewV7()),
		DocumentID:  document,
		Kind:        "blob",
		ContentRef:  deployment.putBlob(t, vaultID, content),
		ContentSize: int64(len(content)),
		Path:        path,
		PathKey:     strings.ToLower(path),
		Deleted:     deleted,
		DeviceID:    deployment.device,
		UserID:      deployment.user,
	}

	if base != nil {
		revision.BaseRevID = uuid.NullUUID{UUID: base.ID, Valid: true}
	}

	committed, err := deployment.store.InVault(vaultID).CommitRevision(t.Context(), revision)
	require.NoError(t, err)

	return committed
}

// insertRawDocument writes a live document straight into the database,
// bypassing CommitRevision's path validation, as a corrupted or tampered
// database could hold it.
func (deployment *deployment) insertRawDocument(t *testing.T, vaultID uuid.UUID, path string, content []byte) uuid.UUID {
	t.Helper()

	blobID := deployment.putBlob(t, vaultID, content)
	document, revision := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())

	err := pgx.BeginFunc(t.Context(), deployment.pool, func(tx pgx.Tx) error {
		var seq int64
		if err := tx.QueryRow(t.Context(), `UPDATE vaults SET head_seq = head_seq + 1 WHERE id = $1 RETURNING head_seq`, vaultID).Scan(&seq); err != nil {
			return err
		}

		if _, err := tx.Exec(t.Context(), `INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key) VALUES ($1, $2, 'blob', $3, $4)`,
			document, vaultID, revision, "raw-"+document.String()); err != nil {
			return err
		}

		_, err := tx.Exec(t.Context(), `
			INSERT INTO revisions (id, document_id, vault_id, seq, content_ref, path, device_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, revision, document, vaultID, seq, blobID, path, deployment.device)

		return err
	})
	require.NoError(t, err)

	return document
}

// state is everything the export must leave unchanged.
func (deployment *deployment) state(t *testing.T) string {
	t.Helper()

	var database string

	err := deployment.pool.QueryRow(t.Context(), `SELECT json_build_object(
		'vaults', (SELECT json_agg(v ORDER BY id) FROM vaults v),
		'documents', (SELECT json_agg(d ORDER BY id) FROM documents d),
		'revisions', (SELECT json_agg(r ORDER BY id) FROM revisions r),
		'blobs', (SELECT json_agg(b ORDER BY vault_id, blob_id) FROM blobs b),
		'blob_uploads', (SELECT json_agg(u ORDER BY id) FROM blob_uploads u),
		'users', (SELECT json_agg(u ORDER BY id) FROM users u),
		'devices', (SELECT json_agg(d ORDER BY id) FROM devices d)
	)::text`).Scan(&database)
	require.NoError(t, err)

	var objects strings.Builder

	paginator := s3.NewListObjectsV2Paginator(deployment.objects.Client(), &s3.ListObjectsV2Input{Bucket: aws.String(deployment.bucket.Bucket)})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(t.Context())
		require.NoError(t, err)

		for _, object := range page.Contents {
			objects.WriteString(aws.ToString(object.Key) + " " + aws.ToString(object.ETag) + "\n")
		}
	}

	return database + "\n" + objects.String()
}

func runMain(t *testing.T, ctx context.Context, env map[string]string, output string) (int, export.Summary) {
	t.Helper()

	code, summary, _ := runMainWithLogs(t, ctx, env, output)

	return code, summary
}

// runMainWithLogs is runMain that also returns the JSON log lines written to
// stderr.
func runMainWithLogs(t *testing.T, ctx context.Context, env map[string]string, output string) (int, export.Summary, []map[string]any) {
	t.Helper()

	var stdout, stderr bytes.Buffer

	code := export.Main(ctx, []string{"-out", output}, func(name string) (string, bool) {
		value, ok := env[name]

		return value, ok
	}, &stdout, &stderr)

	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	require.Len(t, lines, 1, "stdout is one JSON summary line; stderr: %s", stderr.String())

	var summary export.Summary
	require.NoError(t, json.Unmarshal([]byte(lines[0]), &summary))

	var logs []map[string]any

	for line := range strings.Lines(stderr.String()) {
		var record map[string]any
		require.NoError(t, json.Unmarshal([]byte(line), &record), "every log line is JSON: %q", line)

		logs = append(logs, record)
	}

	return code, summary, logs
}

// logRecord returns the one log record with message msg.
func logRecord(t *testing.T, logs []map[string]any, msg string) map[string]any {
	t.Helper()

	var found []map[string]any

	for _, record := range logs {
		if record["msg"] == msg {
			found = append(found, record)
		}
	}

	require.Len(t, found, 1, "one %q log line", msg)

	return found[0]
}

func TestExportAgainstPostgreSQLAndS3(t *testing.T) {
	deployment := newDeployment(t)

	large := make([]byte, blobstore.PartSize+12345)
	_, err := rand.Read(large)
	require.NoError(t, err)

	notes := deployment.createVault(t, "Notes", store.EncryptionNone)

	edited := deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "draft.md", []byte("first draft"))
	edited = deployment.commit(t, notes, edited.DocumentID, &edited, "draft.md", []byte("second draft"))
	final := deployment.commit(t, notes, edited.DocumentID, &edited, "final/essay.md", []byte("final"))

	deleted := deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "trash.md", []byte("trash"))
	deployment.commit(t, notes, deleted.DocumentID, &deleted, "trash.md", nil)

	deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "attachments/video.bin", large)
	deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "same-content.md", []byte("final"))

	// More documents than one page holds.
	want := map[string]string{
		notes.String() + "/final/essay.md":        "final",
		notes.String() + "/attachments/video.bin": string(large),
		notes.String() + "/same-content.md":       "final",
	}

	for range export.DefaultPageSize + 1 {
		path := filepath.Join("many", uuid.Must(uuid.NewV7()).String()+".md")
		deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, path, []byte(path))
		want[notes.String()+"/"+path] = path
	}

	work := deployment.createVault(t, "Notes", store.EncryptionNone)
	deployment.commit(t, work, uuid.Must(uuid.NewV7()), nil, "a.md", []byte("work"))
	want[work.String()+"/a.md"] = "work"

	secret := deployment.createVault(t, "Secret", store.EncryptionE2EE)

	before := deployment.state(t)
	output := filepath.Join(t.TempDir(), "export")

	code, summary := runMain(t, t.Context(), deployment.env(), output)

	assert.Equal(t, 0, code)
	assert.Equal(t, export.StatusOK, summary.Status, summary.Error)
	assert.Equal(t, want, files(t, output))
	assert.Equal(t, before, deployment.state(t), "the export changes nothing in PostgreSQL or S3")

	manifests := verifyManifests(t, output)
	require.Len(t, manifests, 2, "one manifest per exported vault")

	essay := manifests[notes].byID()[edited.DocumentID]
	assert.Equal(t, "final/essay.md", essay.Path)
	assert.Equal(t, "blob", essay.Kind)
	assert.Equal(t, "placed", essay.Status)
	assert.Equal(t, final.ID, essay.RevisionID, "the head revision")
	assert.Len(t, manifests[notes].Documents, 3+export.DefaultPageSize+1, "tombstoned documents are not listed")

	assert.Equal(t, 2, summary.Vaults)
	assert.Equal(t, 1, summary.SkippedVaults)
	assert.EqualValues(t, len(want), summary.Files)

	var total int64
	for _, content := range want {
		total += int64(len(content))
	}

	assert.Equal(t, total, summary.Bytes)
	require.Len(t, summary.VaultDetails, 3)
	assert.Equal(t, export.VaultSummary{ID: secret, Name: "Secret", Encryption: "e2ee", Skipped: export.SkippedE2EE}, summary.VaultDetails[2])
	assert.Equal(t, "Notes", summary.VaultDetails[0].Name)
	assert.Equal(t, int64(export.DefaultPageSize+1+7), summary.VaultDetails[0].HeadSeq)
}

func TestExportKeepsDatabasePathsOutsideTheVaultOutOfItsTree(t *testing.T) {
	deployment := newDeployment(t)
	notes := deployment.createVault(t, "Notes", store.EncryptionNone)

	deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "ok.md", []byte("ok"))

	unplaced := map[uuid.UUID]string{}
	for _, path := range []string{"../escape.md", "a/../../escape.md", "/tmp/escape.md", `..\escape.md`, `C:\escape.md`, `\\server\share\escape.md`} {
		unplaced[deployment.insertRawDocument(t, notes, path, []byte("escape "+path))] = path
	}

	root := t.TempDir()
	output := filepath.Join(root, "export")

	code, summary := runMain(t, t.Context(), deployment.env(), output)

	assert.Equal(t, 0, code, "every document is in the export")
	assert.Equal(t, export.StatusOK, summary.Status)
	assert.Zero(t, summary.DocumentErrors)
	assert.EqualValues(t, len(unplaced), summary.Unplaced)

	want := map[string]string{notes.String() + "/ok.md": "ok"}
	for document, path := range unplaced {
		want[notes.String()+".unplaced/"+document.String()] = "escape " + path
	}

	assert.Equal(t, want, files(t, output))
	assert.Equal(t, []string{".export.lock", "export"}, workspace{root: root}.siblings(t))

	documents := verifyManifests(t, output)[notes].byID()
	for document, path := range unplaced {
		assert.Equal(t, path, documents[document].Path)
		assert.Equal(t, "unplaced", documents[document].Status)
		assert.Equal(t, "path is not vault-relative", documents[document].Reason)
	}
}

func TestExportKeepsDocumentsWhosePathsCannotCoexistAgainstPostgreSQLAndS3(t *testing.T) {
	deployment := newDeployment(t)
	notes := deployment.createVault(t, "Notes", store.EncryptionNone)

	// Written straight to the database: the server may refuse to commit
	// such paths, but existing data can still hold them.
	file := deployment.insertRawDocument(t, notes, "a", []byte("a file"))
	underFile := deployment.insertRawDocument(t, notes, "a/b.md", []byte("a file under a file"))
	tooLong := deployment.insertRawDocument(t, notes, "folder/"+strings.Repeat("n", 256)+".md", []byte("a name over 255 bytes"))

	// User files named like the export's own files.
	lookalikes := map[string]string{
		notes.String() + ".unplaced/" + underFile.String(): "looks like the unplaced copy",
		notes.String() + ".manifest.jsonl":                 "looks like the manifest",
		".vault-sync-export":                               "looks like the marker",
	}

	lookalikeIDs := map[string]uuid.UUID{}
	for path, content := range lookalikes {
		lookalikeIDs[path] = deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, path, []byte(content)).DocumentID
	}

	output := filepath.Join(t.TempDir(), "export")

	code, summary, logs := runMainWithLogs(t, t.Context(), deployment.env(), output)

	assert.Equal(t, 0, code)
	assert.Equal(t, export.StatusOK, summary.Status, summary.Error)
	assert.EqualValues(t, 2, summary.Unplaced)

	// Operators alerting on logs see the collisions (issue #430 item 3).
	finished := logRecord(t, logs, "export finished")
	assert.EqualValues(t, 2, finished["unplaced"])
	assert.EqualValues(t, 0, finished["document_errors"])

	want := map[string]string{
		notes.String() + "/a":                              "a file",
		notes.String() + ".unplaced/" + underFile.String(): "a file under a file",
		notes.String() + ".unplaced/" + tooLong.String():   "a name over 255 bytes",
	}
	for path, content := range lookalikes {
		want[notes.String()+"/"+path] = content
	}

	assert.Equal(t, want, files(t, output), "every document's bytes are in the export")

	documents := verifyManifests(t, output)[notes].byID()
	require.Len(t, documents, 3+len(lookalikes))

	assert.Equal(t, "placed", documents[file].Status)
	assert.Equal(t, "blob", documents[file].Kind)
	assert.Equal(t, "unplaced", documents[underFile].Status)
	assert.Equal(t, "a/b.md", documents[underFile].Path)
	assert.Equal(t, "path conflicts with another document's file or directory", documents[underFile].Reason)
	assert.Equal(t, "unplaced", documents[tooLong].Status)
	assert.Equal(t, "folder/"+strings.Repeat("n", 256)+".md", documents[tooLong].Path)
	assert.Equal(t, "path cannot be created on this filesystem", documents[tooLong].Reason)

	for path, id := range lookalikeIDs {
		assert.Equal(t, "placed", documents[id].Status, path)
		assert.Equal(t, notes.String()+"/"+path, documents[id].Location, path)
	}
}

func TestExportReportsMissingContent(t *testing.T) {
	deployment := newDeployment(t)
	notes := deployment.createVault(t, "Notes", store.EncryptionNone)

	lost := deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "lost.md", []byte("lost"))
	deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "kept.md", []byte("kept"))

	require.NoError(t, deployment.objects.Delete(t.Context(), blobstore.BlobKey(notes, lost.ContentRef)))

	output := filepath.Join(t.TempDir(), "export")

	code, summary := runMain(t, t.Context(), deployment.env(), output)

	assert.Equal(t, 1, code)
	assert.Equal(t, export.StatusPartial, summary.Status)
	assert.Equal(t, map[uuid.UUID]string{lost.DocumentID: "stored content is missing"}, documentErrors(summary))
	assert.Equal(t, map[string]string{notes.String() + "/kept.md": "kept"}, files(t, output))

	documents := verifyManifests(t, output)[notes].byID()
	require.Len(t, documents, 2)
	assert.Equal(t, "missing", documents[lost.DocumentID].Status)
	assert.Equal(t, "lost.md", documents[lost.DocumentID].Path)
	assert.Equal(t, lost.ID, documents[lost.DocumentID].RevisionID)
	assert.Empty(t, documents[lost.DocumentID].Location)
}

// cancelingSource cancels the export after its first content read.
type cancelingSource struct {
	*export.StoreSource
	cancel context.CancelFunc
}

func (source cancelingSource) Content(ctx context.Context, vaultID uuid.UUID, blobID []byte) (io.ReadCloser, error) {
	source.cancel()

	return source.StoreSource.Content(ctx, vaultID, blobID)
}

func TestInterruptedExportAgainstPostgreSQLAndS3LeavesThePreviousExport(t *testing.T) {
	deployment := newDeployment(t)
	notes := deployment.createVault(t, "Notes", store.EncryptionNone)

	first := deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "a.md", []byte("version 1"))
	deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "b.md", []byte("version 1"))

	space := newWorkspace(t)

	code, _ := runMain(t, t.Context(), deployment.env(), space.output)
	require.Equal(t, 0, code)

	previous := snapshot(t, space.output)

	deployment.commit(t, notes, first.DocumentID, &first, "a.md", []byte("version 2"))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	summary, err := export.Run(ctx, export.Options{
		Output: space.output,
		Source: cancelingSource{StoreSource: &export.StoreSource{Store: deployment.store, Objects: deployment.objects}, cancel: cancel},
		Logger: slog.New(slog.DiscardHandler),
	})
	require.Error(t, err)

	assert.Equal(t, export.StatusFailed, summary.Status)
	assert.Equal(t, previous, snapshot(t, space.output))
	assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t))

	// A failure before the export starts (S3 unreachable) also leaves it.
	env := deployment.env()
	env[config.S3BucketEnv] = "no-such-bucket-" + uuid.NewString()

	code, summary = runMain(t, t.Context(), env, space.output)
	assert.Equal(t, 1, code)
	assert.Equal(t, export.StatusFailed, summary.Status)
	assert.Equal(t, previous, snapshot(t, space.output))
}

// committingSource runs commit once, before the second page of documents is
// read.
type committingSource struct {
	*export.StoreSource
	commit func()
	pages  *int
}

func (source committingSource) Documents(ctx context.Context, vaultID uuid.UUID, seq int64, after uuid.UUID, limit int) ([]store.LiveDocument, error) {
	*source.pages++
	if *source.pages == 2 {
		source.commit()
	}

	return source.StoreSource.Documents(ctx, vaultID, seq, after, limit)
}

func TestExportIsAPointInTimeViewAgainstPostgreSQLAndS3(t *testing.T) {
	deployment := newDeployment(t)
	notes := deployment.createVault(t, "Notes", store.EncryptionNone)

	// Document ids grow in creation order, so pages follow it.
	first := deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "first.md", []byte("first"))
	edited := deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "edited.md", []byte("before the edit"))
	renamed := deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "renamed.md", []byte("renamed"))
	deleted := deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "deleted.md", []byte("deleted"))

	var listed int64
	require.NoError(t, deployment.pool.QueryRow(t.Context(), `SELECT head_seq FROM vaults WHERE id = $1`, notes).Scan(&listed))

	pages := 0
	source := committingSource{
		StoreSource: &export.StoreSource{Store: deployment.store, Objects: deployment.objects},
		pages:       &pages,
		commit: func() {
			deployment.commit(t, notes, edited.DocumentID, &edited, "edited.md", []byte("after the edit"))
			deployment.commit(t, notes, renamed.DocumentID, &renamed, "elsewhere/renamed.md", []byte("renamed"))
			deployment.commit(t, notes, deleted.DocumentID, &deleted, "deleted.md", nil)
			deployment.commit(t, notes, uuid.Must(uuid.NewV7()), nil, "new.md", []byte("new"))
		},
	}

	output := filepath.Join(t.TempDir(), "export")

	summary, err := export.Run(t.Context(), export.Options{
		Output:   output,
		Source:   source,
		Logger:   slog.New(slog.DiscardHandler),
		PageSize: 1,
	})
	require.NoError(t, err)
	require.Greater(t, pages, 2, "the commits happened during the export")

	assert.Equal(t, export.StatusOK, summary.Status)
	require.Len(t, summary.VaultDetails, 1)
	assert.Equal(t, listed, summary.VaultDetails[0].HeadSeq)

	assert.Equal(t, map[string]string{
		notes.String() + "/first.md":   "first",
		notes.String() + "/edited.md":  "before the edit",
		notes.String() + "/renamed.md": "renamed",
		notes.String() + "/deleted.md": "deleted",
	}, files(t, output), "the tree is the vault at the listed head_seq")

	documents := verifyManifests(t, output)[notes].byID()
	require.Len(t, documents, 4)
	assert.Equal(t, first.ID, documents[first.DocumentID].RevisionID)
	assert.Equal(t, edited.ID, documents[edited.DocumentID].RevisionID)
	assert.Equal(t, renamed.ID, documents[renamed.DocumentID].RevisionID)
	assert.Equal(t, deleted.ID, documents[deleted.DocumentID].RevisionID)
}
