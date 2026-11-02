package vaultimport_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

// exportFile is one document of a test export.
type exportFile struct {
	path    string
	kind    string
	status  string
	content string
}

// testExport is an export written by the test, as the export job lays it
// out (docs/admin/backup-and-restore.md).
type testExport struct {
	dir       string
	vaultID   uuid.UUID
	documents []export.ManifestDocument
}

func writeExport(t *testing.T, encryption string, files ...exportFile) testExport {
	t.Helper()

	space := testExport{dir: t.TempDir(), vaultID: uuid.New()}

	require.NoError(t, os.WriteFile(filepath.Join(space.dir, export.MarkerName), []byte(`{"format":2,"started_at":"2026-11-02T00:00:00Z"}`+"\n"), 0o600))

	end := export.ManifestEnd{Type: export.ManifestTypeEnd}

	for _, file := range files {
		sum := sha256.Sum256([]byte(file.content))
		document := export.ManifestDocument{
			Type: export.ManifestTypeDocument, DocumentID: uuid.New(), Path: file.path, Kind: file.kind, RevisionID: uuid.New(),
			Size: int64(len(file.content)), SHA256: hex.EncodeToString(sum[:]), Status: file.status,
		}

		end.Documents++

		switch file.status {
		case export.ManifestPlaced:
			end.Placed++
			document.Location = space.vaultID.String() + "/" + file.path
		case export.ManifestUnplaced:
			end.Unplaced++
			document.Location = space.vaultID.String() + export.UnplacedSuffix + "/" + document.DocumentID.String()
		case export.ManifestMissing:
			end.Missing++
			document.Reason = "content missing"
		}

		if document.Location != "" {
			full := filepath.Join(space.dir, filepath.FromSlash(document.Location))
			require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
			require.NoError(t, os.WriteFile(full, []byte(file.content), 0o600))
		}

		space.documents = append(space.documents, document)
	}

	require.NoError(t, os.MkdirAll(filepath.Join(space.dir, space.vaultID.String()), 0o755))

	lines := []any{export.ManifestVault{Type: export.ManifestTypeVault, Format: 2, VaultID: space.vaultID, Name: "v", Encryption: encryption}}
	for _, document := range space.documents {
		lines = append(lines, document)
	}

	lines = append(lines, end)

	var manifest bytes.Buffer

	for _, line := range lines {
		encoded, err := json.Marshal(line)
		require.NoError(t, err)

		manifest.Write(append(encoded, '\n'))
	}

	require.NoError(t, os.WriteFile(space.manifestPath(), manifest.Bytes(), 0o600))

	return space
}

func (space testExport) manifestPath() string {
	return filepath.Join(space.dir, space.vaultID.String()+export.ManifestSuffix)
}

func (space testExport) file(document export.ManifestDocument) string {
	return filepath.Join(space.dir, filepath.FromSlash(document.Location))
}

// restoreRecorder records what a restore creates, by path.
type restoreRecorder struct {
	created map[string]vaultimport.Entry
	// taken refuses these paths once with ALREADY_EXISTS.
	taken map[string]bool
	// failures fails the next calls with these errors, in order.
	failures []error
	// calls records the ids of every call.
	calls [][2]uuid.UUID
}

func newRestoreRecorder() *restoreRecorder {
	return &restoreRecorder{created: map[string]vaultimport.Entry{}, taken: map[string]bool{}}
}

func (target *restoreRecorder) CreateWithIDs(_ context.Context, documentID, revisionID uuid.UUID, entry vaultimport.Entry) error {
	target.calls = append(target.calls, [2]uuid.UUID{documentID, revisionID})

	if len(target.failures) > 0 {
		err := target.failures[0]
		target.failures = target.failures[1:]

		return err
	}

	if target.taken[entry.Path] {
		return &vaultimport.SkipError{Reason: "taken", PathTaken: true}
	}

	target.created[entry.Path] = entry

	return nil
}

func restore(t *testing.T, space testExport, allowPartial bool, target *restoreRecorder, logs *bytes.Buffer) (vaultimport.RestoreResult, error) {
	t.Helper()

	manifest, err := vaultimport.ReadExportManifest(space.dir, space.vaultID)
	require.NoError(t, err)

	if logs == nil {
		logs = &bytes.Buffer{}
	}

	return vaultimport.Restore(t.Context(), vaultimport.RestoreOptions{
		ExportDir: space.dir, Manifest: manifest, MaxFileBytes: 1 << 20, AllowPartial: allowPartial,
		Logger: slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Target: func(context.Context) (vaultimport.RestoreTarget, error) { return target, nil },
	})
}

func TestRestoreCreatesEveryDocumentAndReportsFallbacksAndMissing(t *testing.T) {
	space := writeExport(t, "none",
		exportFile{path: "notes/a.md", kind: "text", status: export.ManifestPlaced, content: "# a"},
		exportFile{path: "notes/img.png", kind: "blob", status: export.ManifestPlaced, content: "\x89PNG"},
		exportFile{path: "Notes/A.md", kind: "text", status: export.ManifestUnplaced, content: "collision"},
		exportFile{path: "other/b.md", kind: "text", status: export.ManifestUnplaced, content: "kept"},
		exportFile{path: "gone.md", kind: "text", status: export.ManifestMissing},
	)
	target := newRestoreRecorder()

	var logs bytes.Buffer

	result, err := restore(t, space, false, target, &logs)
	require.NoError(t, err)

	collision := space.documents[2]
	fallbackPath := "Restored files/" + collision.DocumentID.String() + ".md"

	assert.Equal(t, map[string]vaultimport.Entry{
		"notes":          {Path: "notes", Kind: vaultimport.KindFolder},
		"notes/a.md":     {Path: "notes/a.md", Kind: vaultimport.KindText, Content: []byte("# a")},
		"notes/img.png":  {Path: "notes/img.png", Kind: vaultimport.KindBlob, Content: []byte("\x89PNG")},
		"other":          {Path: "other", Kind: vaultimport.KindFolder},
		"other/b.md":     {Path: "other/b.md", Kind: vaultimport.KindText, Content: []byte("kept")},
		"Restored files": {Path: "Restored files", Kind: vaultimport.KindFolder},
		fallbackPath:     {Path: fallbackPath, Kind: vaultimport.KindText, Content: []byte("collision")},
	}, target.created)

	assert.Equal(t, []vaultimport.FallbackDocument{{DocumentID: collision.DocumentID.String(), Path: "Notes/A.md", RestoredPath: fallbackPath}}, result.Fallback)
	assert.Equal(t, []vaultimport.MissingDocument{{DocumentID: space.documents[4].DocumentID.String(), Path: "gone.md", Reason: "content missing"}}, result.Missing)
	assert.Empty(t, result.FailedVerification)
	assert.Equal(t, vaultimport.Counts{Text: 3, Blob: 1, Folder: 3}, result.Imported)

	for _, secret := range []string{"notes", "other", "gone", "# a", "collision", "kept"} {
		assert.NotContains(t, logs.String(), secret)
	}
}

// damage changes an export in one way.
type damage struct {
	name string
	// format is true when the damage is to the format or the manifest's
	// shape, which -allow-partial does not get past.
	format bool
	reason string
	apply  func(t *testing.T, space testExport)
}

func rewriteManifest(t *testing.T, space testExport, edit func(string) string) {
	t.Helper()

	content, err := os.ReadFile(space.manifestPath())
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(space.manifestPath(), []byte(edit(string(content))), 0o600))
}

var damages = []damage{
	{name: "a changed byte", reason: vaultimport.ReasonHashDiffers, apply: func(t *testing.T, space testExport) {
		require.NoError(t, os.WriteFile(space.file(space.documents[0]), []byte("# A"), 0o600))
	}},
	{name: "a deleted file", reason: vaultimport.ReasonFileMissing, apply: func(t *testing.T, space testExport) {
		require.NoError(t, os.Remove(space.file(space.documents[0])))
	}},
	{name: "a longer file", reason: vaultimport.ReasonSizeDiffers, apply: func(t *testing.T, space testExport) {
		require.NoError(t, os.WriteFile(space.file(space.documents[0]), []byte("# a\n"), 0o600))
	}},
	{name: "a symbolic link", reason: vaultimport.ReasonFileMissing, apply: func(t *testing.T, space testExport) {
		target := filepath.Join(t.TempDir(), "a.md")
		require.NoError(t, os.WriteFile(target, []byte("# a"), 0o600))
		require.NoError(t, os.Remove(space.file(space.documents[0])))
		require.NoError(t, os.Symlink(target, space.file(space.documents[0])))
	}},
	{name: "a file no line names", reason: vaultimport.ReasonNotInExport, apply: func(t *testing.T, space testExport) {
		require.NoError(t, os.WriteFile(filepath.Join(space.dir, space.vaultID.String(), "extra.md"), []byte("x"), 0o600))
	}},
	{name: "a manifest without its end line", format: true, apply: func(t *testing.T, space testExport) {
		rewriteManifest(t, space, func(manifest string) string {
			lines := strings.SplitAfter(manifest, "\n")

			return strings.Join(lines[:len(lines)-2], "")
		})
	}},
	{name: "a cut manifest", format: true, apply: func(t *testing.T, space testExport) {
		rewriteManifest(t, space, func(manifest string) string { return manifest[:len(manifest)-5] })
	}},
	{name: "another format in the manifest", format: true, apply: func(t *testing.T, space testExport) {
		rewriteManifest(t, space, func(manifest string) string { return strings.Replace(manifest, `"format":2`, `"format":3`, 1) })
	}},
	{name: "another format in the marker", format: true, apply: func(t *testing.T, space testExport) {
		require.NoError(t, os.WriteFile(filepath.Join(space.dir, export.MarkerName), []byte(`{"format":1}`), 0o600))
	}},
	{name: "a location outside its tree", format: true, apply: func(t *testing.T, space testExport) {
		rewriteManifest(t, space, func(manifest string) string {
			return strings.Replace(manifest, `"location":"`+space.vaultID.String()+`/b.md"`, `"location":"`+uuid.NewString()+`/b.md"`, 1)
		})
	}},
	{name: "counts that do not match", format: true, apply: func(t *testing.T, space testExport) {
		rewriteManifest(t, space, func(manifest string) string { return strings.Replace(manifest, `"documents":2`, `"documents":3`, 1) })
	}},
	{name: "a repeated document id", format: true, apply: func(t *testing.T, space testExport) {
		rewriteManifest(t, space, func(manifest string) string {
			return strings.Replace(manifest, space.documents[1].DocumentID.String(), space.documents[0].DocumentID.String(), 1)
		})
	}},
}

func TestRestoreOfADamagedExportCreatesNothing(t *testing.T) {
	for _, test := range damages {
		t.Run(test.name, func(t *testing.T) {
			space := writeExport(t, "none",
				exportFile{path: "a.md", kind: "text", status: export.ManifestPlaced, content: "# a"},
				exportFile{path: "b.md", kind: "text", status: export.ManifestPlaced, content: "# b"},
			)
			test.apply(t, space)

			target := newRestoreRecorder()

			_, err := vaultimport.ReadExportManifest(space.dir, space.vaultID)
			if test.format {
				require.ErrorIs(t, err, vaultimport.ErrExportFormat)

				return
			}

			require.NoError(t, err)

			result, err := restore(t, space, false, target, nil)
			require.ErrorIs(t, err, vaultimport.ErrVerificationFailed)
			assert.Empty(t, target.created)
			assert.Empty(t, target.calls)
			require.Len(t, result.FailedVerification, 1)
			assert.Equal(t, test.reason, result.FailedVerification[0].Reason)
		})
	}
}

func TestRestoreWithAllowPartialImportsWhatVerifies(t *testing.T) {
	for _, test := range damages {
		if test.format {
			continue
		}

		t.Run(test.name, func(t *testing.T) {
			space := writeExport(t, "none",
				exportFile{path: "a.md", kind: "text", status: export.ManifestPlaced, content: "# a"},
				exportFile{path: "b.md", kind: "text", status: export.ManifestPlaced, content: "# b"},
			)
			test.apply(t, space)

			target := newRestoreRecorder()

			result, err := restore(t, space, true, target, nil)
			require.NoError(t, err)

			assert.Contains(t, target.created, "b.md")
			assert.Equal(t, test.reason == vaultimport.ReasonNotInExport, len(target.created) == 2, "a.md is left out unless only an extra file failed")
			assert.NotContains(t, target.created, "extra.md")
			require.Len(t, result.FailedVerification, 1)
			assert.Equal(t, test.reason, result.FailedVerification[0].Reason)
		})
	}
}

func TestRestoreRefusesAFileOverTheSizeLimit(t *testing.T) {
	space := writeExport(t, "none", exportFile{path: "big.bin", kind: "blob", status: export.ManifestPlaced, content: strings.Repeat("x", 11)})

	manifest, err := vaultimport.ReadExportManifest(space.dir, space.vaultID)
	require.NoError(t, err)

	for limit, failed := range map[int64]bool{10: true, 11: false} {
		failures, err := vaultimport.VerifyExport(space.dir, manifest, limit)
		require.NoError(t, err)
		assert.Equal(t, failed, len(failures) == 1, "limit %d", limit)

		if failed {
			assert.Equal(t, vaultimport.ReasonOverLimit, failures[0].Reason)
		}
	}
}

func TestRestoreMovesADocumentWhosePathIsTakenToTheFallback(t *testing.T) {
	space := writeExport(t, "none", exportFile{path: "a.md", kind: "text", status: export.ManifestPlaced, content: "# a"})
	target := newRestoreRecorder()
	target.taken["a.md"] = true

	result, err := restore(t, space, false, target, nil)
	require.NoError(t, err)

	fallbackPath := "Restored files/" + space.documents[0].DocumentID.String() + ".md"
	assert.Contains(t, target.created, fallbackPath)
	assert.Equal(t, []vaultimport.FallbackDocument{{DocumentID: space.documents[0].DocumentID.String(), Path: "a.md", RestoredPath: fallbackPath}}, result.Fallback)
}

func TestRestoreRetriesTransientFailuresWithTheSameIDs(t *testing.T) {
	space := writeExport(t, "none", exportFile{path: "a.md", kind: "text", status: export.ManifestPlaced, content: "# a"})
	target := newRestoreRecorder()
	target.failures = []error{
		connect.NewError(connect.CodeUnavailable, nil),
		connect.NewError(connect.CodeDeadlineExceeded, nil),
	}

	vaultimport.SetRetryDelayForTest(t, 0)

	_, err := restore(t, space, false, target, nil)
	require.NoError(t, err)

	require.Len(t, target.calls, 3)
	assert.Equal(t, target.calls[0], target.calls[1])
	assert.Equal(t, target.calls[0], target.calls[2])
	assert.Contains(t, target.created, "a.md")
}

func TestRestoreStopsOnAnUnexpectedRefusal(t *testing.T) {
	space := writeExport(t, "none",
		exportFile{path: "a.md", kind: "text", status: export.ManifestPlaced, content: "# a"},
		exportFile{path: "b.md", kind: "text", status: export.ManifestPlaced, content: "# b"},
	)

	for name, refusal := range map[string]error{
		"a refused size":   &vaultimport.SkipError{Reason: "the server refused the file"},
		"permission":       connect.NewError(connect.CodePermissionDenied, nil),
		"invalid argument": connect.NewError(connect.CodeInvalidArgument, nil),
	} {
		t.Run(name, func(t *testing.T) {
			target := newRestoreRecorder()
			target.failures = []error{refusal}

			_, err := restore(t, space, false, target, nil)
			require.Error(t, err)

			assert.Len(t, target.calls, 1, "the run stops at the first refusal and skips nothing")
			assert.Empty(t, target.created)
		})
	}
}
