//go:build integration

package server_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"log/slog"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

func TestServerRefusesToStartWithAnEscrowChainThatDoesNotLink(t *testing.T) {
	first, second := newEscrowKey(t), newEscrowKey(t)

	tests := []struct {
		name       string
		statement  func() store.EscrowRotationStatement
		configured escrowKey
	}{
		{
			name:       "a statement signed by the new key",
			statement:  func() store.EscrowRotationStatement { return rotate(t, second.sign, first, second) },
			configured: second,
		},
		{
			name:       "the configuration is not the chain's head",
			statement:  func() store.EscrowRotationStatement { return rotate(t, first.sign, first, second) },
			configured: first,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := testinfra.PostgresConfig(t)

			pool, err := store.Open(t.Context(), cfg)
			require.NoError(t, err)
			t.Cleanup(pool.Close)

			_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
			require.NoError(t, err)

			queries := store.New(pool)

			_, err = queries.EscrowChain(t.Context(), first.encoded)
			require.NoError(t, err)
			require.NoError(t, queries.AppendEscrowRotation(t.Context(), 1, test.statement()))

			var stdout, stderr bytes.Buffer

			// A server that wrongly starts serves until this deadline.
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()

			code := server.Main(ctx, nil, lookup(map[string]string{
				config.DatabaseURLEnv:          cfg.DSN,
				config.OIDCIssuerURLEnv:        "https://issuer.example",
				config.OIDCAudienceEnv:         "vault-sync",
				config.ListenAddressEnv:        "127.0.0.1:0",
				config.MetricsListenAddressEnv: "127.0.0.2:0",
				config.EscrowRecipientEnv:      test.configured.bundle.Recipient,
				config.EscrowSigningKeyEnv:     base64.StdEncoding.EncodeToString(test.configured.bundle.SignPub),
			}), &stdout, &stderr)

			assert.Equal(t, 1, code)
			assert.Contains(t, stderr.String(), "cannot use the escrow chain")
		})
	}
}
