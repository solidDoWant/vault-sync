package server

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// deadlineRecorder is a response writer standing in for the HTTP server's
// connection, recording the write deadlines set on it.
type deadlineRecorder struct {
	http.ResponseWriter

	mu        sync.Mutex
	deadlines []time.Time
}

func (recorder *deadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	recorder.deadlines = append(recorder.deadlines, deadline)

	return nil
}

// No route served today returns without writing (each writes a status or
// hijacks the connection), so this covers limitResponseTime directly.
func TestHandlersThatWriteNothingGetAWriteDeadline(t *testing.T) {
	const timeout = time.Hour

	recorder := &deadlineRecorder{ResponseWriter: httptest.NewRecorder()}
	handler := limitResponseTime(timeout, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	before := time.Now()

	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil))

	// net/http writes the response after the handler returns; the deadline
	// must already bound that write.
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	if assert.Len(t, recorder.deadlines, 1, "the response net/http writes must be bounded by a write deadline") {
		assert.False(t, recorder.deadlines[0].Before(before.Add(timeout)), "the deadline must be the write timeout from now")
	}
}
