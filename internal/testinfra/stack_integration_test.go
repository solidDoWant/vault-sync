//go:build integration

package testinfra_test

import (
	"io"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

func TestPostgresIsReachable(t *testing.T) {
	pool, err := store.Open(t.Context(), testinfra.PostgresConfig(t))
	require.NoError(t, err)

	defer pool.Close()

	var one int
	require.NoError(t, pool.QueryRow(t.Context(), "SELECT 1").Scan(&one))
	assert.Equal(t, 1, one)
}

func TestS3StoreIsReachable(t *testing.T) {
	s3 := testinfra.S3(t)

	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, s3.Endpoint, nil)
	require.NoError(t, err)

	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	require.NoError(t, err)

	// An unsigned request must be refused with an S3 error document, which
	// shows an S3 API (not just any HTTP server) is listening.
	assert.Equal(t, http.StatusForbidden, response.StatusCode)
	assert.Contains(t, string(body), "<Error>")
}
