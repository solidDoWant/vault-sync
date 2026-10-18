package pathkey_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/pathkey"
)

type vector struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	PathKey string `json:"path_key"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "paths", "vectors.json"))
	require.NoError(t, err)

	var file struct {
		Vectors []vector `json:"vectors"`
	}

	require.NoError(t, json.Unmarshal(data, &file))
	require.NotEmpty(t, file.Vectors)

	return file.Vectors
}

func TestKeyMatchesSharedVectors(t *testing.T) {
	for _, vector := range loadVectors(t) {
		t.Run(vector.Name, func(t *testing.T) {
			assert.Equal(t, vector.PathKey, pathkey.Key(vector.Path))
		})
	}
}

func TestKeyIsIdempotent(t *testing.T) {
	for _, vector := range loadVectors(t) {
		t.Run(vector.Name, func(t *testing.T) {
			key := pathkey.Key(vector.Path)
			assert.Equal(t, key, pathkey.Key(key))
		})
	}
}

func TestKeyIsSafeForConcurrentUse(t *testing.T) {
	vectors := loadVectors(t)

	done := make(chan struct{})

	for range 8 {
		go func() {
			defer func() { done <- struct{}{} }()

			for _, vector := range vectors {
				assert.Equal(t, vector.PathKey, pathkey.Key(vector.Path))
			}
		}()
	}

	for range 8 {
		<-done
	}
}

func TestKeyIsIdempotentForEveryCodePoint(t *testing.T) {
	for codePoint := rune(0); codePoint <= unicode.MaxRune; codePoint++ {
		if !utf8.ValidRune(codePoint) {
			continue // surrogates
		}

		key := pathkey.Key(string(codePoint))
		if again := pathkey.Key(key); again != key {
			t.Errorf("Key is not idempotent for %U: %q then %q", codePoint, key, again)
		}
	}
}
