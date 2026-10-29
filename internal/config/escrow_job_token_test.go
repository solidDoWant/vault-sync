package config_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/config"
)

func TestLoadEscrowJobToken(t *testing.T) {
	token := strings.Repeat("t", 44)
	shortest := strings.Repeat("s", 32)

	tests := []struct {
		name      string
		file      string
		path      string
		wantToken []byte
		assertErr require.ErrorAssertionFunc
	}{
		{name: "unset turns the endpoint off"},
		{name: "a token with a trailing newline", file: token + "\n", wantToken: []byte(token)},
		{name: "the shortest token", file: shortest, wantToken: []byte(shortest)},
		{name: "one character short", file: shortest[1:], assertErr: errorContaining(config.EscrowJobTokenFileEnv)},
		{name: "an empty file", file: "\n", assertErr: errorContaining(config.EscrowJobTokenFileEnv)},
		{name: "two lines", file: token + "\n" + token, assertErr: errorContaining(config.EscrowJobTokenFileEnv)},
		{name: "the largest file", file: strings.Repeat("x", 4<<10), wantToken: []byte(strings.Repeat("x", 4<<10))},
		{name: "one byte too large", file: strings.Repeat("x", 4<<10+1), assertErr: errorContaining(config.EscrowJobTokenFileEnv)},
		{name: "a missing file", path: filepath.Join(t.TempDir(), "missing"), assertErr: errorContaining(config.EscrowJobTokenFileEnv)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertErr := test.assertErr
			if assertErr == nil {
				assertErr = require.NoError
			}

			path := test.path
			if test.file != "" {
				path = writeFile(t, "token", test.file)
			}

			env := map[string]string{}
			if path != "" {
				env[config.EscrowJobTokenFileEnv] = path
			}

			cfg, err := config.Load(lookup(withRequired(env)))
			assertErr(t, err)

			if test.assertErr == nil {
				assert.Equal(t, test.wantToken, cfg.EscrowJobToken)
			} else {
				assert.NotContains(t, err.Error(), shortest[1:], "the token is never echoed")
			}
		})
	}
}
