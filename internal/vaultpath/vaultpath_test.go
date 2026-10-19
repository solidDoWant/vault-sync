package vaultpath_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/vaultpath"
)

type vector struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Valid bool   `json:"valid"`
	New   bool   `json:"new"`
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
