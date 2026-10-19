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

// The allowed range startup reports for the request limit starts at the
// smallest limit it accepts, 16384 bytes, as docs/configuration.md says.
func TestLoadReportsTheRequestLimitRangeItEnforces(t *testing.T) {
	const allowedRange = "allowed range 16384 to 67108864 bytes"

	tests := []struct {
		value    string
		rejected bool
	}{
		{value: "1023", rejected: true},
		{value: "1024", rejected: true},
		{value: "16383", rejected: true},
		{value: "16384"},
		{value: "67108864"},
		{value: "67108865", rejected: true},
	}

	for _, test := range tests {
		t.Run(test.value, func(t *testing.T) {
			_, err := config.Load(lookup(withRequired(map[string]string{config.MaxRequestBytesEnv: test.value})))

			if !test.rejected {
				// 16384 still fails the chunk size check, which is not
				// a range problem.
				if err != nil {
					assert.NotContains(t, err.Error(), allowedRange)
				}

				return
			}

			require.Error(t, err)
			assert.Contains(t, err.Error(), config.MaxRequestBytesEnv+": "+test.value+" is outside the "+allowedRange)
		})
	}
}
