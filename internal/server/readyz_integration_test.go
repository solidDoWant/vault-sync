//go:build integration

package server_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

func TestReadyzAgainstPostgreSQL(t *testing.T) {
	pool, err := store.Open(t.Context(), testinfra.PostgresConfig(t))
	require.NoError(t, err)

	running := startServer(t, server.Options{Database: pool})

	status, _ := get(t, running.metricsURL()+"/readyz")
	assert.Equal(t, http.StatusOK, status)
}
