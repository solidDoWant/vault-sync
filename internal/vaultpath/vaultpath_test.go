package vaultpath_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/vaultpath"
)

type vector struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Repeat int    `json:"repeat"`
	Suffix string `json:"suffix"`
	Valid  bool   `json:"valid"`
	New    bool   `json:"new"`
}

// loadVectors reads the validity vectors shared with the TypeScript client
// (plugin/src/core/vaultpath).
func loadVectors(t *testing.T) []vector {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "paths", "validity.json"))
	require.NoError(t, err)

	var file struct {
		Vectors []vector `json:"vectors"`
	}

	require.NoError(t, json.Unmarshal(data, &file))
	require.NotEmpty(t, file.Vectors)

	for index := range file.Vectors {
		vector := &file.Vectors[index]
		vector.Path = strings.Repeat(vector.Path, max(vector.Repeat, 1)) + vector.Suffix
	}

	return file.Vectors
}

func TestCheckMatchesSharedVectors(t *testing.T) {
	for _, vector := range loadVectors(t) {
		t.Run(vector.Name, func(t *testing.T) {
			err := vaultpath.Check(vector.Path)
			if vector.Valid {
				assert.NoError(t, err, "path %q", vector.Path)
			} else {
				assert.Error(t, err, "path %q", vector.Path)
			}
		})
	}
}

func TestCheckNewMatchesSharedVectors(t *testing.T) {
	for _, vector := range loadVectors(t) {
		t.Run(vector.Name, func(t *testing.T) {
			err := vaultpath.CheckNew(vector.Path)
			if vector.New {
				assert.NoError(t, err, "path %q", vector.Path)
			} else {
				assert.Error(t, err, "path %q", vector.Path)
			}
		})
	}
}

func TestCheckNewReportsWhichRuleFailed(t *testing.T) {
	errorIs := func(want error) require.ErrorAssertionFunc {
		return func(t require.TestingT, err error, args ...any) {
			require.ErrorIs(t, err, want, args...)
		}
	}

	tests := []struct {
		name           string
		path           string
		errorAssertion require.ErrorAssertionFunc
	}{
		{name: "new path", path: "notes/c.md"},
		{name: "backslash only", path: `notes\c.md`, errorAssertion: errorIs(vaultpath.ErrBackslash)},
		{name: "not relative", path: `..\c.md`, errorAssertion: errorIs(vaultpath.ErrNotRelative)},
		{name: "issue 148: drive-like prefix", path: "1:x.md", errorAssertion: errorIs(vaultpath.ErrDrivePrefix)},
		{name: "issue 148: non-ASCII drive-like prefix", path: "é:x.md", errorAssertion: errorIs(vaultpath.ErrDrivePrefix)},
		{name: "issue 148: drive-like prefix and a backslash", path: `1:\x.md`, errorAssertion: errorIs(vaultpath.ErrNotNew)},
		{name: "issue 148: backslash is not new", path: `notes\c.md`, errorAssertion: errorIs(vaultpath.ErrNotNew)},
		{name: "forbidden character", path: "notes/a?.md", errorAssertion: errorIs(vaultpath.ErrForbiddenCharacter)},
		{name: "colon after the first character", path: "ab:c.md", errorAssertion: errorIs(vaultpath.ErrForbiddenCharacter)},
		{name: "leading space", path: " a.md", errorAssertion: errorIs(vaultpath.ErrEdgeSpace)},
		{name: "trailing space in a folder", path: "notes /a.md", errorAssertion: errorIs(vaultpath.ErrEdgeSpace)},
		{name: "trailing dot", path: "notes./a.md", errorAssertion: errorIs(vaultpath.ErrTrailingDot)},
		{name: "reserved name", path: "com1.md", errorAssertion: errorIs(vaultpath.ErrReservedName)},
		{name: "longest name", path: strings.Repeat("a", vaultpath.MaxNameBytes)},
		{name: "name one byte too long", path: strings.Repeat("a", vaultpath.MaxNameBytes+1), errorAssertion: errorIs(vaultpath.ErrNameTooLong)},
		{name: "longest path", path: strings.Repeat(strings.Repeat("a", 254)+"/", 4) + "abcd"},
		{name: "path one byte too long", path: strings.Repeat(strings.Repeat("a", 254)+"/", 4) + "abcde", errorAssertion: errorIs(vaultpath.ErrNewTooLong)},
		{name: "portable rules are not new", path: "CON.md", errorAssertion: errorIs(vaultpath.ErrNotNew)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.errorAssertion == nil {
				test.errorAssertion = require.NoError
			}

			test.errorAssertion(t, vaultpath.CheckNew(test.path))
		})
	}
}

// A path CheckNew refuses only because it may no longer be created, not
// because it is not vault-relative, is ErrNotNew: CommitRevision then
// accepts it only as a live document's unchanged path (SPEC.md §6.2).
func TestCheckNewMarksKeepOnlyPaths(t *testing.T) {
	for _, vector := range loadVectors(t) {
		t.Run(vector.Name, func(t *testing.T) {
			err := vaultpath.CheckNew(vector.Path)
			assert.Equal(t, vector.Valid && !vector.New, errors.Is(err, vaultpath.ErrNotNew), "path %q: %v", vector.Path, err)
		})
	}
}

type textVector struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Repeat int    `json:"repeat"`
	Valid  bool   `json:"valid"`
	New    bool   `json:"new"`
}

// loadTextVectors reads the path text vectors shared with the TypeScript
// client (plugin/src/core/vaultpath), each path repeated as given.
func loadTextVectors(t *testing.T) []textVector {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "paths", "text.json"))
	require.NoError(t, err)

	var file struct {
		Vectors []textVector `json:"vectors"`
	}

	require.NoError(t, json.Unmarshal(data, &file))
	require.NotEmpty(t, file.Vectors)

	for index := range file.Vectors {
		vector := &file.Vectors[index]
		if vector.Repeat == 0 {
			vector.Repeat = 1
		}

		vector.Path = strings.Repeat(vector.Path, vector.Repeat)
	}

	return file.Vectors
}

func TestCheckTextMatchesSharedVectors(t *testing.T) {
	valid, invalid := 0, 0

	for _, vector := range loadTextVectors(t) {
		t.Run(vector.Name, func(t *testing.T) {
			err := vaultpath.CheckText(vector.Path)
			if vector.Valid {
				valid++

				assert.NoError(t, err, "path of %d bytes", len(vector.Path))
			} else {
				invalid++

				assert.Error(t, err, "path of %d bytes", len(vector.Path))
			}

			// Every non-empty text vector is otherwise vault-relative, and
			// new unless it breaks the new-path length limits.
			if vector.Path != "" && vector.Valid {
				assert.Equal(t, vector.New, vaultpath.CheckNew(vector.Path) == nil, "path of %d bytes", len(vector.Path))
			}
		})
	}

	assert.Positive(t, valid)
	assert.Positive(t, invalid)
}

func TestCheckTextReportsWhichRuleFailed(t *testing.T) {
	errorIs := func(want error) require.ErrorAssertionFunc {
		return func(t require.TestingT, err error, args ...any) {
			require.ErrorIs(t, err, want, args...)
		}
	}

	tests := []struct {
		name           string
		path           string
		errorAssertion require.ErrorAssertionFunc
	}{
		{name: "longest", path: strings.Repeat("a", 4096)},
		{name: "empty", path: "", errorAssertion: errorIs(vaultpath.ErrLength)},
		{name: "one byte too long", path: strings.Repeat("a", 4097), errorAssertion: errorIs(vaultpath.ErrLength)},
		{name: "control character", path: "a\x00b", errorAssertion: errorIs(vaultpath.ErrNotPrintable)},
		{name: "invalid UTF-8", path: "a\xffb", errorAssertion: errorIs(vaultpath.ErrNotPrintable)},
		{name: "UTF-8 encoded surrogate", path: "a\xed\xa0\x80b", errorAssertion: errorIs(vaultpath.ErrNotPrintable)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.errorAssertion == nil {
				test.errorAssertion = require.NoError
			}

			test.errorAssertion(t, vaultpath.CheckText(test.path))
		})
	}
}

func TestSharedVectorsCoverEveryOutcome(t *testing.T) {
	newPaths, oldOnly, invalid := 0, 0, 0

	for _, vector := range loadVectors(t) {
		switch {
		case vector.New:
			assert.True(t, vector.Valid, "a new path is valid: %q", vector.Name)

			newPaths++
		case vector.Valid:
			oldOnly++
		default:
			invalid++
		}
	}

	assert.Positive(t, newPaths)
	assert.Positive(t, oldOnly)
	assert.Positive(t, invalid)
}
