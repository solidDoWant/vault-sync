package vaultimport_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

// recordingTarget records what Import creates, refusing the paths in
// refuse.
type recordingTarget struct {
	created map[string]vaultimport.Entry
	refuse  map[string]string
}

func (target *recordingTarget) Create(_ context.Context, entry vaultimport.Entry) error {
	if reason, ok := target.refuse[entry.Path]; ok {
		return &vaultimport.SkipError{Reason: reason}
	}

	target.created[entry.Path] = entry

	return nil
}

// writeTree creates files (path → content) and empty folders under a new
// directory and returns it.
func writeTree(t *testing.T, files map[string]string, folders ...string) string {
	t.Helper()

	root := t.TempDir()

	for name, content := range files {
		full := filepath.Join(root, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
		require.NoError(t, os.WriteFile(full, []byte(content), 0o600))
	}

	for _, folder := range folders {
		require.NoError(t, os.MkdirAll(filepath.Join(root, filepath.FromSlash(folder)), 0o755))
	}

	return root
}

func runImport(t *testing.T, root string, maxFileBytes int64, refuse map[string]string) (*recordingTarget, vaultimport.Result) {
	t.Helper()

	target := &recordingTarget{created: map[string]vaultimport.Entry{}, refuse: refuse}

	result, err := vaultimport.Import(t.Context(), vaultimport.Options{Source: root, MaxFileBytes: maxFileBytes, Target: target})
	require.NoError(t, err)

	return target, result
}

func TestImportCreatesOneDocumentPerFileAndEmptyFolder(t *testing.T) {
	root := writeTree(t, map[string]string{
		"Welcome.md":           "# Welcome\n",
		"Notes/Daily/today.md": "today",
		"Notes/picture.png":    "\x89PNG",
		"Notes/README.MD.txt":  "plain",
		"empty.md":             "",
	}, "Archive/Empty", "Inbox")

	target, result := runImport(t, root, 1<<20, nil)

	want := map[string]vaultimport.Entry{
		"Welcome.md":           {Path: "Welcome.md", Kind: vaultimport.KindText, Content: []byte("# Welcome\n")},
		"Notes/Daily/today.md": {Path: "Notes/Daily/today.md", Kind: vaultimport.KindText, Content: []byte("today")},
		"Notes/picture.png":    {Path: "Notes/picture.png", Kind: vaultimport.KindBlob, Content: []byte("\x89PNG")},
		"Notes/README.MD.txt":  {Path: "Notes/README.MD.txt", Kind: vaultimport.KindBlob, Content: []byte("plain")},
		"empty.md":             {Path: "empty.md", Kind: vaultimport.KindText, Content: []byte{}},
		"Archive/Empty":        {Path: "Archive/Empty", Kind: vaultimport.KindFolder},
		"Inbox":                {Path: "Inbox", Kind: vaultimport.KindFolder},
	}
	assert.Equal(t, want, target.created)
	assert.Equal(t, vaultimport.Counts{Text: 3, Blob: 2, Folder: 2}, result.Imported)
	assert.Equal(t, int64(len("# Welcome\ntoday\x89PNGplain")), result.Bytes)
	assert.Empty(t, result.Skipped)
}

func TestImportNormalizesNamesToNFC(t *testing.T) {
	// "Café" spelled with a combining acute accent (NFD, as macOS writes it).
	root := writeTree(t, map[string]string{"Café/menu.md": "menu"})

	target, result := runImport(t, root, 1<<20, nil)

	assert.Contains(t, target.created, "Café/menu.md")
	assert.Empty(t, result.Skipped)
}

func TestImportSkipsAndReportsUnportableNames(t *testing.T) {
	tests := []struct {
		name   string
		file   string
		reason string
	}{
		{name: "less-than", file: "a<b.md", reason: `must not contain any of < > : " | ? *`},
		{name: "greater-than", file: "a>b.md", reason: `must not contain any of < > : " | ? *`},
		{name: "colon", file: "ab:c.md", reason: `must not contain any of < > : " | ? *`},
		{name: "double quote", file: `a"b.md`, reason: `must not contain any of < > : " | ? *`},
		{name: "backslash", file: `a\b.md`, reason: `must not contain "\"`},
		{name: "pipe", file: "a|b.md", reason: `must not contain any of < > : " | ? *`},
		{name: "question mark", file: "a?b.md", reason: `must not contain any of < > : " | ? *`},
		{name: "asterisk", file: "a*b.md", reason: `must not contain any of < > : " | ? *`},
		{name: "control character", file: "a\tb.md", reason: "without control characters"},
		{name: "delete character", file: "a\x7fb.md", reason: "without control characters"},
		{name: "leading space", file: " a.md", reason: "must not start or end with a space"},
		{name: "trailing space", file: "a.md ", reason: "must not start or end with a space"},
		{name: "trailing dot", file: "a.", reason: "must not end in a dot"},
		{name: "reserved name", file: "CON", reason: "Windows reserved name"},
		{name: "reserved name with an extension", file: "nul.md", reason: "Windows reserved name"},
		{name: "reserved COM9", file: "com9.txt", reason: "Windows reserved name"},
		{name: "reserved LPT1", file: "LPT1.md", reason: "Windows reserved name"},
		{name: "invalid UTF-8", file: "a\xffb.md", reason: "not valid UTF-8"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := writeTree(t, map[string]string{test.file: "skipped", "kept.md": "kept"})

			target, result := runImport(t, root, 1<<20, nil)

			assert.Equal(t, []string{"kept.md"}, keys(target.created), "only the portable file is imported")
			require.Len(t, result.Skipped, 1)
			assert.Equal(t, test.file, result.Skipped[0].Path)
			assert.Contains(t, result.Skipped[0].Reason, "unportable name")
			assert.Contains(t, result.Skipped[0].Reason, test.reason)
		})
	}
}

func TestImportAcceptsNamesAtThePortableLimits(t *testing.T) {
	tests := []struct {
		name string
		file string
	}{
		{name: "name of 255 bytes", file: strings.Repeat("é", 126) + "abc"},
		{name: "reserved name inside a longer name", file: "CONFIG.md"},
		{name: "COM0 is not reserved", file: "COM0.md"},
		{name: "inner spaces and dots", file: "a b.c d.md"},
		{name: "hidden file", file: ".hidden.md"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := writeTree(t, map[string]string{test.file: "kept"})

			target, result := runImport(t, root, 1<<20, nil)

			assert.Equal(t, []string{test.file}, keys(target.created))
			assert.Empty(t, result.Skipped)
		})
	}
}

func TestImportBoundsTheWholePathAt1024Bytes(t *testing.T) {
	// 4 folders of 250 bytes and their separators take 1004 bytes.
	folders := strings.Repeat(strings.Repeat("f", 250)+"/", 4)

	fits := folders + strings.Repeat("a", 1024-len(folders)-3) + ".md"
	tooLong := folders + strings.Repeat("b", 1025-len(folders)-3) + ".md"

	require.Len(t, fits, 1024)
	require.Len(t, tooLong, 1025)

	root := writeTree(t, map[string]string{fits: "fits", tooLong: "too long"})

	target, result := runImport(t, root, 1<<20, nil)

	assert.Equal(t, []string{fits}, keys(target.created))
	require.Len(t, result.Skipped, 1)
	assert.Equal(t, tooLong, result.Skipped[0].Path)
	assert.Contains(t, result.Skipped[0].Reason, "must be at most 1024 bytes")
}

func TestImportSkipsAFolderWithAnUnportableNameWithItsContents(t *testing.T) {
	root := writeTree(t, map[string]string{"bad:folder/note.md": "inside", "good.md": "kept"})

	target, result := runImport(t, root, 1<<20, nil)

	assert.Equal(t, []string{"good.md"}, keys(target.created))
	require.Len(t, result.Skipped, 1)
	assert.Equal(t, "bad:folder", result.Skipped[0].Path)
	assert.Contains(t, result.Skipped[0].Reason, "nothing in the folder was imported")
}

func TestImportSkipsFilesOverTheSizeLimit(t *testing.T) {
	root := writeTree(t, map[string]string{"at-limit.bin": "12345", "over-limit.bin": "123456"})

	target, result := runImport(t, root, 5, nil)

	assert.Equal(t, []string{"at-limit.bin"}, keys(target.created))
	require.Len(t, result.Skipped, 1)
	assert.Equal(t, "over-limit.bin", result.Skipped[0].Path)
	assert.Contains(t, result.Skipped[0].Reason, "size limit of 5 bytes")
}

func TestImportSkipsSymbolicLinks(t *testing.T) {
	root := writeTree(t, map[string]string{"target.md": "target"})
	require.NoError(t, os.Symlink(filepath.Join(root, "target.md"), filepath.Join(root, "link.md")))

	target, result := runImport(t, root, 1<<20, nil)

	assert.Equal(t, []string{"target.md"}, keys(target.created))
	require.Len(t, result.Skipped, 1)
	assert.Equal(t, "link.md", result.Skipped[0].Path)
	assert.Contains(t, result.Skipped[0].Reason, "symbolic link")
}

func TestImportReportsDocumentsTheTargetRefuses(t *testing.T) {
	root := writeTree(t, map[string]string{"a.md": "a", "b.md": "b"})

	target, result := runImport(t, root, 1<<20, map[string]string{"b.md": "same name as a.md"})

	assert.Equal(t, []string{"a.md"}, keys(target.created))
	assert.Equal(t, []vaultimport.Skip{{Path: "b.md", Reason: "same name as a.md"}}, result.Skipped)
	assert.Equal(t, vaultimport.Counts{Text: 1}, result.Imported)
}

func TestImportRefusesASourceThatIsNotAFolder(t *testing.T) {
	file := filepath.Join(t.TempDir(), "note.md")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o600))

	for _, source := range []string{file, filepath.Join(t.TempDir(), "missing")} {
		target := &recordingTarget{created: map[string]vaultimport.Entry{}}

		_, err := vaultimport.Import(t.Context(), vaultimport.Options{Source: source, MaxFileBytes: 1 << 20, Target: target})
		require.Error(t, err, source)
	}
}

func keys(created map[string]vaultimport.Entry) []string {
	paths := make([]string, 0, len(created))
	for path := range created {
		paths = append(paths, path)
	}

	return paths
}
