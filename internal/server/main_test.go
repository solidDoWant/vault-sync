package server_test

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/version"
)

func lookup(env map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, ok := env[name]

		return value, ok
	}
}

func TestMainExitsNonZeroNamingEachConfigurationProblem(t *testing.T) {
	tests := []struct {
		name         string
		env          map[string]string
		wantProblems []string
	}{
		{
			name:         "empty environment",
			env:          map[string]string{},
			wantProblems: []string{config.DatabaseURLEnv},
		},
		{
			name: "several invalid variables",
			env: map[string]string{
				config.ListenAddressEnv:   "no-port",
				config.MaxRequestBytesEnv: "lots",
				config.ShutdownTimeoutEnv: "-5s",
				config.LogLevelEnv:        "chatty",
			},
			wantProblems: []string{
				config.DatabaseURLEnv,
				config.ListenAddressEnv,
				config.MaxRequestBytesEnv,
				config.ShutdownTimeoutEnv,
				config.LogLevelEnv,
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer

			code := server.Main(t.Context(), nil, lookup(test.env), &stdout, &stderr)

			assert.NotZero(t, code)

			for _, problem := range test.wantProblems {
				assert.Contains(t, stderr.String(), problem)
			}
		})
	}
}

func TestMainPrintsVersion(t *testing.T) {
	var stdout, stderr bytes.Buffer

	code := server.Main(t.Context(), []string{"-version"}, lookup(nil), &stdout, &stderr)

	assert.Zero(t, code)
	assert.Equal(t, version.String()+"\n", stdout.String())
}

func TestMainRejectsUnknownFlags(t *testing.T) {
	var stdout, stderr bytes.Buffer

	code := server.Main(t.Context(), []string{"-bogus"}, lookup(nil), &stdout, &stderr)

	assert.NotZero(t, code)
}
