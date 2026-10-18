package config_test

import (
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/config"
)

// Every page of revisions holds at least one, so the request (and send)
// limit must fit a response with a single maximum-size revision; startup
// rejects a smaller limit.
func TestLoadRequiresTheRequestLimitToFitOneRevision(t *testing.T) {
	const problem = "the largest ListChanges or GetDocumentHistory response with a single revision"

	_, err := config.Load(lookup(withRequired(map[string]string{config.MaxRequestBytesEnv: strconv.Itoa(api.MinResponseLimitBytes - 1)})))
	require.Error(t, err)
	assert.Contains(t, err.Error(), config.MaxRequestBytesEnv)
	assert.Contains(t, err.Error(), problem)

	// The minimum itself passes this check; the chunk size check still
	// asks for more.
	_, err = config.Load(lookup(withRequired(map[string]string{config.MaxRequestBytesEnv: strconv.Itoa(api.MinResponseLimitBytes)})))
	require.Error(t, err)
	assert.NotContains(t, err.Error(), problem)
	assert.Contains(t, err.Error(), config.BlobMaxChunkBytesEnv)
}
