//go:build sim

package sim_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestReportKeepsTheFaithfulFilesystem: the case the driver writes for a
// failing seed keeps whether the run used the faithful filesystem, so the
// regressions suite replays it with the same setting (#598). A folded case
// is written without the field, as every case before it was.
func TestReportKeepsTheFaithfulFilesystem(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		expected map[string]any
	}{
		{
			name:     "faithful case",
			body:     `{"name":"seed-7-faithful-fs","seed":7,"clients":3,"engines":2,"commitRetryBackoff":30,"faithfulFilesystem":true,"violations":[],"steps":[]}`,
			expected: map[string]any{"name": "seed-7-faithful-fs", "seed": 7.0, "clients": 3.0, "engines": 2.0, "commitRetryBackoff": 30.0, "faithfulFilesystem": true, "violations": []any{}, "steps": []any{}},
		},
		{
			name:     "case with notification-gated pulls",
			body:     `{"name":"seed-7","seed":7,"clients":3,"engines":2,"commitRetryBackoff":30,"notificationPulls":true,"violations":[],"steps":[]}`,
			expected: map[string]any{"name": "seed-7", "seed": 7.0, "clients": 3.0, "engines": 2.0, "commitRetryBackoff": 30.0, "notificationPulls": true, "violations": []any{}, "steps": []any{}},
		},
		{
			name:     "case with queued engine pushes",
			body:     `{"name":"seed-7","seed":7,"clients":3,"engines":2,"commitRetryBackoff":30,"notificationPulls":true,"queuedPushes":true,"violations":[],"steps":[]}`,
			expected: map[string]any{"name": "seed-7", "seed": 7.0, "clients": 3.0, "engines": 2.0, "commitRetryBackoff": 30.0, "notificationPulls": true, "queuedPushes": true, "violations": []any{}, "steps": []any{}},
		},
		{
			name:     "folded case",
			body:     `{"name":"seed-7","seed":7,"clients":3,"engines":2,"commitRetryBackoff":30,"violations":[],"steps":[]}`,
			expected: map[string]any{"name": "seed-7", "seed": 7.0, "clients": 3.0, "engines": 2.0, "commitRetryBackoff": 30.0, "violations": []any{}, "steps": []any{}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctl := &control{regressionDir: t.TempDir()}
			recorder := httptest.NewRecorder()
			ctl.handler().ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/report", strings.NewReader(test.body)))
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

			var response struct {
				Path string `json:"path"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
			assert.Equal(t, filepath.Join(ctl.regressionDir, test.expected["name"].(string)+".json"), response.Path)

			written, err := os.ReadFile(response.Path)
			require.NoError(t, err)

			var recorded map[string]any
			require.NoError(t, json.Unmarshal(written, &recorded))
			assert.Equal(t, test.expected, recorded)
		})
	}
}
