package export_test

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/export"
)

func TestMainRejectsInvalidUsage(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "no output directory", args: nil},
		{name: "empty output directory", args: []string{"-out", ""}},
		{name: "unknown flag", args: []string{"-out", "x", "-force"}},
		{name: "extra argument", args: []string{"-out", "x", "more"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer

			code := export.Main(t.Context(), test.args, func(string) (string, bool) { return "", false }, &stdout, &stderr)

			assert.Equal(t, 2, code)
			assert.Empty(t, stdout.String(), "no summary for a usage error")
			assert.NotEmpty(t, stderr.String())
		})
	}
}

func TestMainReportsInvalidConfigurationAsAFailedSummary(t *testing.T) {
	output := filepath.Join(t.TempDir(), "out")
	env := map[string]string{config.DatabaseURLEnv: "postgres://vault_sync:secret-password@db.example/x?sslmode=bogus"}

	var stdout, stderr bytes.Buffer

	code := export.Main(t.Context(), []string{"-out", output}, func(name string) (string, bool) {
		value, ok := env[name]

		return value, ok
	}, &stdout, &stderr)

	assert.Equal(t, 1, code)

	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	require.Len(t, lines, 1, "the summary is one JSON line")

	var summary export.Summary
	require.NoError(t, json.Unmarshal([]byte(lines[0]), &summary))

	assert.Equal(t, export.StatusFailed, summary.Status)
	assert.Equal(t, output, summary.Output)
	assert.Contains(t, summary.Error, config.DatabaseURLEnv)
	assert.Contains(t, summary.Error, config.S3BucketEnv)
	assert.NotNil(t, summary.VaultDetails)
	assert.NotContains(t, stdout.String()+stderr.String(), "secret-password")
}
