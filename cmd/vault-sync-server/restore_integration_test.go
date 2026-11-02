//go:build integration && linux

package main_test

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

// restoreExport runs `vault-sync-server import -from-export exportDir
// -source-vault sourceVault [flags] SERVER_URL vaultID` and returns its exit
// code, report and logs.
func restoreExport(t *testing.T, binary string, server *instance, flow *authtest.DeviceFlow,
	subject, exportDir, sourceVault, vaultID string, flags ...string,
) (int, vaultimport.RestoreReport, string) {
	t.Helper()

	args := append([]string{"-from-export", exportDir, "-source-vault", sourceVault}, flags...)
	code, stdout, logs := runImportCommand(t, binary, flow, subject, append(args, server.apiURL, vaultID))

	var report vaultimport.RestoreReport
	if len(stdout) > 0 {
		require.NoError(t, json.Unmarshal(stdout, &report), "restore report: %s", stdout)
	}

	return code, report, logs
}

// insertUnplaceableDocument writes a text document at path straight to the
// database, beside documents whose paths it collides with on disk, as data
// written before a path rule existed could.
func (cluster *deployment) insertUnplaceableDocument(t *testing.T, device *syncClient, server *instance, path, content string) string {
	t.Helper()

	blob := device.content(t, server, content)
	document, revision := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	conn := cluster.connectDatabase(t)

	require.NoError(t, pgx.BeginFunc(t.Context(), conn, func(tx pgx.Tx) error {
		var seq int64
		if err := tx.QueryRow(t.Context(), `UPDATE vaults SET head_seq = head_seq + 1 WHERE id = $1 RETURNING head_seq`, device.vaultID).Scan(&seq); err != nil {
			return err
		}

		if _, err := tx.Exec(t.Context(), `INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key) VALUES ($1, $2, 'text', $3, $4)`,
			document, device.vaultID, revision, "raw-"+document.String()); err != nil {
			return err
		}

		_, err := tx.Exec(t.Context(), `
			INSERT INTO revisions (id, document_id, vault_id, seq, content_ref, path, device_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, revision, document, device.vaultID, seq, blob.GetBlobId(), path, device.deviceID)

		return err
	}))

	return document.String()
}

// deleteBlob removes a blob's object from the bucket, as a lost object.
func (cluster *deployment) deleteBlob(t *testing.T, vaultID string, blobID []byte) {
	t.Helper()

	objects, err := blobstore.New(cluster.objects)
	require.NoError(t, err)

	_, err = objects.Client().DeleteObject(t.Context(), &s3.DeleteObjectInput{
		Bucket: aws.String(cluster.objects.Bucket), Key: aws.String(blobstore.BlobKey(uuid.MustParse(vaultID), blobID)),
	})
	require.NoError(t, err)
}

func TestRestoreFromExport(t *testing.T) {
	cluster := newDeployment(t)
	flow := cluster.issuer.EnableDeviceFlow(t, cluster.key, authtest.DeviceFlowOptions{})
	binary := buildServer(t)
	escrow := newEscrowKey(t)
	server := cluster.start(t, "server", binary,
		append([]string{config.OIDCClientIDEnv + "=" + authtest.DefaultAudience}, escrow.environment()...)...)
	token := cluster.token(t, "alice")

	identityFile := filepath.Join(t.TempDir(), "escrow-identity.txt")
	require.NoError(t, os.WriteFile(identityFile, []byte("# public key: "+escrow.recipient+"\n"+escrow.identity+"\n"), 0o600))

	marker := strings.ToLower(rand.Text())
	text := vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT
	blob := vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB
	folder := vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER

	// The source vault: placed files in nested folders, a folder document,
	// an unplaced document (a file under a file) and a missing document.
	source := createVault(t, server, token, "Source")
	device := newSyncClient(t, server, token, source.GetId())

	contents := map[string]string{
		"Notes " + marker + "/plan.md":          "# plan " + marker,
		"Notes " + marker + "/deep/diagram.png": "\x89PNG " + marker,
		"x":                                     "a file named x " + marker,
	}

	for path, content := range contents {
		request := device.create(t, path, device.content(t, server, content))
		if !strings.HasSuffix(path, ".md") {
			request.Kind = blob
		}

		device.mustCommit(t, server, request)
	}

	emptyFolder := device.create(t, "Empty "+marker, nil)
	emptyFolder.Kind = folder
	device.mustCommit(t, server, emptyFolder)

	goneContent := device.content(t, server, "gone "+marker)
	gone := device.mustCommit(t, server, device.create(t, "gone "+marker+".md", goneContent))
	cluster.deleteBlob(t, source.GetId(), goneContent.GetBlobId())

	unplacedID := cluster.insertUnplaceableDocument(t, device, server, "x/under "+marker+".md", "under a file "+marker)

	output := filepath.Join(t.TempDir(), "export")
	_, summary := cluster.exportVaults(t, binary, identityFile, output)
	require.Equal(t, export.StatusPartial, summary.Status, "the export is partial: one document's content is missing")

	copyExport := func(t *testing.T) string {
		t.Helper()

		copied := filepath.Join(t.TempDir(), "export")
		require.NoError(t, os.CopyFS(copied, os.DirFS(output)))

		return copied
	}

	t.Run("[P6-01] a plaintext vault is restored with every exported document, its fallbacks and its missing documents", func(t *testing.T) {
		target := createVault(t, server, token, "Restored")

		code, report, logs := restoreExport(t, binary, server, flow, "alice", output, source.GetId(), target.GetId())
		assert.Equal(t, 1, code, "a restore with a fallback or a missing document exits 1")
		require.Equal(t, vaultimport.StatusPartial, report.Status, report.Error)

		fallbackPath := "Restored files/" + unplacedID + ".md"
		assert.Equal(t, []vaultimport.FallbackDocument{{DocumentID: unplacedID, Path: "x/under " + marker + ".md", RestoredPath: fallbackPath}}, report.Fallback)
		require.Len(t, report.Missing, 1)
		assert.Equal(t, gone.GetDocumentId(), report.Missing[0].DocumentID)
		assert.Empty(t, report.FailedVerification)
		assert.Empty(t, report.Skipped)

		assert.Equal(t, map[string]syncedFile{
			"Notes " + marker:                       {Kind: folder},
			"Notes " + marker + "/deep":             {Kind: folder},
			"Notes " + marker + "/plan.md":          {Kind: text, Digest: digest(contents["Notes "+marker+"/plan.md"])},
			"Notes " + marker + "/deep/diagram.png": {Kind: blob, Digest: digest(contents["Notes "+marker+"/deep/diagram.png"])},
			"x":                                     {Kind: blob, Digest: digest(contents["x"])},
			"Restored files":                        {Kind: folder},
			fallbackPath:                            {Kind: text, Digest: digest("under a file " + marker)},
		}, newSyncClient(t, server, token, target.GetId()).syncAll(t, server))

		assert.NotContains(t, logs, marker, "the logs name documents by id, never by path or content")
	})

	damages := []struct {
		name   string
		format bool
		apply  func(t *testing.T, dir string)
	}{
		{name: "a changed byte", apply: func(t *testing.T, dir string) {
			path := filepath.Join(dir, source.GetId(), "x")
			require.NoError(t, os.WriteFile(path, []byte("A file named x "+marker), 0o600))
		}},
		{name: "a deleted file", apply: func(t *testing.T, dir string) {
			require.NoError(t, os.Remove(filepath.Join(dir, source.GetId(), "x")))
		}},
		{name: "a manifest without its end line", format: true, apply: func(t *testing.T, dir string) {
			manifest := filepath.Join(dir, source.GetId()+export.ManifestSuffix)
			content, err := os.ReadFile(manifest)
			require.NoError(t, err)

			lines := strings.SplitAfter(string(content), "\n")
			require.NoError(t, os.WriteFile(manifest, []byte(strings.Join(lines[:len(lines)-2], "")), 0o600))
		}},
		{name: "another format version", format: true, apply: func(t *testing.T, dir string) {
			require.NoError(t, os.WriteFile(filepath.Join(dir, export.MarkerName), []byte(`{"format":3}`+"\n"), 0o600))
		}},
	}

	for _, damage := range damages {
		t.Run("[P6-02] "+damage.name+" is reported and nothing is created", func(t *testing.T) {
			dir := copyExport(t)
			damage.apply(t, dir)

			target := createVault(t, server, token, "Damaged")
			code, report, _ := restoreExport(t, binary, server, flow, "alice", dir, source.GetId(), target.GetId())
			assert.Equal(t, 1, code)
			assert.Equal(t, vaultimport.StatusFailed, report.Status)

			if !damage.format {
				require.Len(t, report.FailedVerification, 1)
			}

			assert.Empty(t, newSyncClient(t, server, token, target.GetId()).syncAll(t, server), "nothing is created")

			partialTarget := createVault(t, server, token, "Damaged, partial")
			code, report, _ = restoreExport(t, binary, server, flow, "alice", dir, source.GetId(), partialTarget.GetId(), "-allow-partial")
			assert.Equal(t, 1, code)

			restored := newSyncClient(t, server, token, partialTarget.GetId()).syncAll(t, server)

			if damage.format {
				assert.Equal(t, vaultimport.StatusFailed, report.Status, "-allow-partial does not get past a format failure")
				assert.Empty(t, restored)

				return
			}

			assert.Equal(t, vaultimport.StatusPartial, report.Status, report.Error)
			require.Len(t, report.FailedVerification, 1)
			assert.Equal(t, folder, restored["x"].Kind, "the damaged file is left out, so the unplaced document under it keeps its path")
			assert.Contains(t, restored, "Notes "+marker+"/plan.md", "the files that verify are imported")
		})
	}

	t.Run("[P6-01] an escrowed encrypted vault is restored into an encrypted vault", func(t *testing.T) {
		alice := newEncryptedMember(t, server, cluster.token(t, "carol"))
		passphraseFile := filepath.Join(t.TempDir(), "passphrase")
		require.NoError(t, os.WriteFile(passphraseFile, []byte(alice.passphrase+"\n"), 0o600))

		files := map[string]string{
			"Diary " + marker + ".md":             "# diary " + marker,
			"Attachments/scan " + marker + ".pdf": "%PDF " + marker,
		}

		folderSource := t.TempDir()

		for name, content := range files {
			full := filepath.Join(folderSource, filepath.FromSlash(name))
			require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
			require.NoError(t, os.WriteFile(full, []byte(content), 0o600))
		}

		escrowed := createEscrowedVault(t, server, alice, escrow, "Escrowed", 1)
		code, report, _ := cluster.importFolderWithLogs(t, binary, server, flow, "carol", escrowed.GetId(), folderSource, "-passphrase-file", passphraseFile)
		require.Equal(t, vaultimport.StatusOK, report.Status, report.Error)
		require.Equal(t, 0, code)

		escrowedOutput := filepath.Join(t.TempDir(), "export")
		_, summary := cluster.exportVaults(t, binary, identityFile, escrowedOutput)
		require.NotEqual(t, export.StatusFailed, summary.Status, summary.Error)

		t.Run("into a plaintext vault it is refused", func(t *testing.T) {
			plaintext := createVault(t, server, cluster.token(t, "carol"), "Plaintext")

			code, report, _ := restoreExport(t, binary, server, flow, "carol", escrowedOutput, escrowed.GetId(), plaintext.GetId())
			assert.Equal(t, 1, code)
			assert.Equal(t, vaultimport.StatusFailed, report.Status)
			assert.Contains(t, report.Error, "end-to-end encrypted")
			assert.Empty(t, newSyncClient(t, server, cluster.token(t, "carol"), plaintext.GetId()).syncAll(t, server))
		})

		restored := createEscrowedVault(t, server, alice, escrow, "Restored escrowed", 1)

		code, restoreReport, logs := restoreExport(t, binary, server, flow, "carol", escrowedOutput, escrowed.GetId(), restored.GetId(),
			"-passphrase-file", passphraseFile)
		require.Equal(t, vaultimport.StatusOK, restoreReport.Status, restoreReport.Error)
		assert.Equal(t, 0, code)

		assert.Equal(t, map[string]syncedFile{
			"Diary " + marker + ".md":             {Kind: text, Digest: digest(files["Diary "+marker+".md"])},
			"Attachments":                         {Kind: folder},
			"Attachments/scan " + marker + ".pdf": {Kind: blob, Digest: digest(files["Attachments/scan "+marker+".pdf"])},
		}, alice.decryptAll(t, server, restored.GetId()))
		assert.NotContains(t, logs, marker)
	})
}
