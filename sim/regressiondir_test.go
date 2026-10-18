package sim_test

// This file has no build tag: the resolution of SIM_REGRESSION_DIR is unit
// tested by `make test`, while the driver that uses it (simulation_test.go)
// needs the `sim` tag.

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// defaultRegressionDir is where the committed regression cases live,
// relative to the repository root.
var defaultRegressionDir = filepath.Join("sim", "regressions")

// resolveRegressionDir returns the absolute regression directory for the
// value of SIM_REGRESSION_DIR. A relative value is relative to the repository
// root (where `make test-sim` runs), not to the package directory `go test`
// runs in (#131); an empty value is the committed sim/regressions.
func resolveRegressionDir(value, repoRoot string) string {
	if value == "" {
		value = defaultRegressionDir
	}

	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}

	return filepath.Join(repoRoot, value)
}

func TestResolveRegressionDir(t *testing.T) {
	repoRoot, err := filepath.Abs("..")
	require.NoError(t, err)

	committed := filepath.Join(repoRoot, "sim", "regressions")
	absolute := t.TempDir()

	tests := []struct {
		name  string
		value string
		want  string
	}{
		{name: "unset is the committed directory", value: "", want: committed},
		{name: "the documented default names the committed directory", value: "sim/regressions", want: committed},
		{name: "a relative value is relative to the repository root", value: "build/cases", want: filepath.Join(repoRoot, "build", "cases")},
		{name: "a relative value may leave the repository", value: "../elsewhere", want: filepath.Join(filepath.Dir(repoRoot), "elsewhere")},
		{name: "an absolute value is used as is", value: absolute, want: absolute},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, resolveRegressionDir(test.value, repoRoot))
		})
	}
}

// The documented default must reach the committed cases, not a nonexistent
// directory under sim/ (#131).
func TestResolveRegressionDirFindsCommittedCases(t *testing.T) {
	repoRoot, err := filepath.Abs("..")
	require.NoError(t, err)

	_, err = os.Stat(filepath.Join(resolveRegressionDir("sim/regressions", repoRoot), "simfault-stale-base.json"))
	require.NoError(t, err)
}
