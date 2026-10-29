//go:build integration

package main_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

// importFolder runs `vault-sync-server import vaultID source` against the
// deployment and returns its exit code and report.
func (cluster *deployment) importFolder(t *testing.T, binary, vaultID, source string) (int, vaultimport.Report) {
	t.Helper()

	var stdout, stderr bytes.Buffer

	command := exec.CommandContext(t.Context(), binary, "import", vaultID, source)

	command.Env = append(os.Environ(),
		config.DatabaseURLEnv+"="+cluster.database.DSN,
		config.S3EndpointEnv+"="+cluster.objects.Endpoint,
		config.S3RegionEnv+"="+cluster.objects.Region,
		config.S3BucketEnv+"="+cluster.objects.Bucket,
		config.S3AccessKeyIDFileEnv+"="+cluster.objects.AccessKeyIDFile,
		config.S3SecretAccessKeyFileEnv+"="+cluster.objects.SecretAccessKeyFile,
		config.S3ForcePathStyleEnv+"="+strconv.FormatBool(cluster.objects.ForcePathStyle),
	)
	command.Stdout = &stdout
	command.Stderr = &stderr

	code := 0

	var exitErr *exec.ExitError

	if err := command.Run(); errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
	} else {
		require.NoError(t, err, "import: %s", stderr.String())
	}

	var report vaultimport.Report
	if stdout.Len() > 0 {
		require.NoError(t, json.Unmarshal(stdout.Bytes(), &report), "import report: %s", stdout.String())
	}

	t.Logf("import logs:\n%s", stderr.String())

	return code, report
}

// folderKind is the FOLDER document kind.
const folderKind = vaultsyncv1.DocumentKind(4)

// syncedFile is one document a device holds after a full sync.
type syncedFile struct {
	Kind vaultsyncv1.DocumentKind
	// Digest is the hex SHA-256 of the downloaded content; empty for a
	// folder.
	Digest string
}

// digest returns the hex SHA-256 of content.
func digest(content string) string {
	sum := sha256.Sum256([]byte(content))

	return hex.EncodeToString(sum[:])
}

// syncAll pulls the whole change feed as a fresh device does and downloads
// every live document's head content, by path.
func (client *syncClient) syncAll(t *testing.T, server *instance) map[string]syncedFile {
	t.Helper()

	revisions, _ := client.changes(t, 0, server)

	heads := map[string]*vaultsyncv1.Revision{}
	for _, revision := range revisions {
		heads[revision.GetDocumentId()] = revision
	}

	files := map[string]syncedFile{}

	for _, head := range heads {
		if head.GetDeleted() {
			continue
		}

		file := syncedFile{Kind: head.GetKind()}

		if blobID := head.GetContentRef().GetBlobId(); len(blobID) > 0 {
			blob := &blobClient{token: client.token, vaultID: client.vaultID, blobID: blobID}
			file.Digest = digest(string(blob.download(t, server)))
		}

		files[string(head.GetPath())] = file
	}

	return files
}

func TestImportSubcommand(t *testing.T) {
	cluster := newDeployment(t)
	binary := buildServer(t)
	server := cluster.start(t, "server", binary)
	token := cluster.token(t, "alice")

	t.Run("[AC-23] a device syncs exactly the imported notes, attachments and empty folders", func(t *testing.T) {
		vault := createVault(t, server, token, "Imported")

		attachment := make([]byte, 3<<20)
		for index := range attachment {
			attachment[index] = byte(index * 7)
		}

		source := t.TempDir()
		files := map[string]string{
			"Welcome.md":              "# Welcome\n\nImported from disk.\n",
			"Projects/Plan.md":        "- [ ] ship\n",
			"Projects/Notes/Ideas.md": "",
			"Attachments/diagram.png": string(attachment),
			"Attachments/paper.pdf":   "%PDF-1.7\n",
			"Café/menu.md":           "NFD on disk",
			"unportable:name.md":      "never imported",
			"Projects/trailing dot.":  "never imported",
		}

		for name, content := range files {
			full := filepath.Join(source, filepath.FromSlash(name))
			require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
			require.NoError(t, os.WriteFile(full, []byte(content), 0o600))
		}

		require.NoError(t, os.MkdirAll(filepath.Join(source, "Attachments", "Empty"), 0o755))
		require.NoError(t, os.MkdirAll(filepath.Join(source, "Archive", "Empty"), 0o755))

		code, report := cluster.importFolder(t, binary, vault.GetId(), source)
		assert.Equal(t, 1, code, "an import that skipped names exits 1")
		assert.Equal(t, vaultimport.StatusPartial, report.Status)
		assert.ElementsMatch(t, []string{"unportable:name.md", "Projects/trailing dot."}, skippedPaths(report))
		assert.Equal(t, vaultimport.Counts{Text: 4, Blob: 2, Folder: 2}, report.Imported)

		device := newSyncClient(t, server, token, vault.GetId())

		text := vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT
		blob := vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB
		assert.Equal(t, map[string]syncedFile{
			"Welcome.md":              {Kind: text, Digest: digest(files["Welcome.md"])},
			"Projects/Plan.md":        {Kind: text, Digest: digest(files["Projects/Plan.md"])},
			"Projects/Notes/Ideas.md": {Kind: text, Digest: digest("")},
			"Café/menu.md":            {Kind: text, Digest: digest("NFD on disk")},
			"Attachments/diagram.png": {Kind: blob, Digest: digest(string(attachment))},
			"Attachments/paper.pdf":   {Kind: blob, Digest: digest(files["Attachments/paper.pdf"])},
			"Attachments/Empty":       {Kind: folderKind},
			"Archive/Empty":           {Kind: folderKind},
		}, device.syncAll(t, server))

		history := device.history(t, headOf(t, device, server, "Welcome.md").GetDocumentId(), 0, server)
		assert.Len(t, history, 1, "an imported document has no history")
	})

	t.Run("a vault that has documents is refused", func(t *testing.T) {
		vault := createVault(t, server, token, "Used")
		device := newSyncClient(t, server, token, vault.GetId())
		device.mustCommit(t, server, device.create(t, "existing.md", device.content(t, server, "existing")))

		source := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(source, "new.md"), []byte("new"), 0o600))

		code, report := cluster.importFolder(t, binary, vault.GetId(), source)
		assert.Equal(t, 1, code)
		assert.Equal(t, vaultimport.StatusFailed, report.Status)
		assert.Contains(t, report.Error, "not empty")
		assert.Equal(t, []string{"existing.md"}, keysOf(device.syncAll(t, server)))
	})

	t.Run("usage errors exit 2", func(t *testing.T) {
		code, _ := cluster.importFolder(t, binary, "not-a-vault-id", t.TempDir())
		assert.Equal(t, 2, code)
	})
}

func skippedPaths(report vaultimport.Report) []string {
	paths := make([]string, 0, len(report.Skipped))
	for _, skip := range report.Skipped {
		paths = append(paths, skip.Path)
	}

	return paths
}

func keysOf(files map[string]syncedFile) []string {
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}

	return paths
}

// headOf returns the head revision of the live document at path.
func headOf(t *testing.T, client *syncClient, server *instance, path string) *vaultsyncv1.Revision {
	t.Helper()

	revisions, _ := client.changes(t, 0, server)

	for index := len(revisions) - 1; index >= 0; index-- {
		if string(revisions[index].GetPath()) == path {
			return revisions[index]
		}
	}

	require.Failf(t, "no document", "no revision at %q", path)

	return nil
}
