package vaultimport_test

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestImportReachesTheVaultOnlyThroughTheAPI checks that the import is a
// client of the server's API: no file of the package imports the database
// or the object store.
func TestImportReachesTheVaultOnlyThroughTheAPI(t *testing.T) {
	forbidden := []string{
		"github.com/solidDoWant/vault-sync/internal/store",
		"github.com/solidDoWant/vault-sync/internal/blobstore",
		"github.com/jackc/pgx",
		"github.com/aws/aws-sdk-go-v2",
	}

	files, err := filepath.Glob("*.go")
	require.NoError(t, err)

	checked := 0

	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}

		source, err := os.ReadFile(file)
		require.NoError(t, err)

		parsed, err := parser.ParseFile(token.NewFileSet(), file, source, parser.ImportsOnly)
		require.NoError(t, err)

		for _, spec := range parsed.Imports {
			path, err := strconv.Unquote(spec.Path.Value)
			require.NoError(t, err)

			for _, prefix := range forbidden {
				assert.False(t, path == prefix || strings.HasPrefix(path, prefix+"/"), "%s imports %s", file, path)
			}
		}

		checked++
	}

	assert.Positive(t, checked)
}
