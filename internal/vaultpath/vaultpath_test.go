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

func TestSharedVectorsCoverBothOutcomes(t *testing.T) {
	valid, invalid := 0, 0

	for _, vector := range loadVectors(t) {
		if vector.Valid {
			valid++
		} else {
			invalid++
		}
	}

	assert.Positive(t, valid)
	assert.Positive(t, invalid)
}
