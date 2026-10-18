package server_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/solidDoWant/vault-sync/internal/server"
)

// gatedDatabase is a database whose pings answer only once released. A
// ping whose context was canceled fails; the readiness timeout's deadline
// is ignored, so that tests do not depend on how fast they run.
type gatedDatabase struct {
	// entered is closed when the first ping starts.
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	calls   atomic.Int64
}

func newGatedDatabase() *gatedDatabase {
	return &gatedDatabase{entered: make(chan struct{}), release: make(chan struct{})}
}

func (database *gatedDatabase) Ping(ctx context.Context) error {
	database.calls.Add(1)
	database.once.Do(func() { close(database.entered) })

	<-database.release

	if err := ctx.Err(); errors.Is(err, context.Canceled) {
		return err
	}

	return nil
}

// waitingContext reports when its caller first waits on it. A readiness
// check waits on its caller's context only once it has joined the shared
// ping.
type waitingContext struct {
	context.Context //nolint:containedctx // wrapped to observe Done

	once    sync.Once
	waiting chan struct{}
}

func (ctx *waitingContext) Done() <-chan struct{} {
	ctx.once.Do(func() { close(ctx.waiting) })

	return ctx.Context.Done()
}

func TestReadyzSharedPingOutlivesTheCallerThatStartedIt(t *testing.T) {
	database := newGatedDatabase()
	handler := server.New(testOptions(server.Options{Database: database})).MetricsHandler()

	readyz := func(ctx context.Context) <-chan int {
		status := make(chan int, 1)

		go func() {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequestWithContext(ctx, http.MethodGet, "/readyz", nil))

			status <- recorder.Code
		}()

		return status
	}

	// The first caller starts the ping; the second joins it.
	firstCtx, leave := context.WithCancel(t.Context())
	defer leave()

	first := readyz(firstCtx)

	<-database.entered

	secondCtx := &waitingContext{Context: t.Context(), waiting: make(chan struct{})}
	second := readyz(secondCtx)

	<-secondCtx.waiting

	// The first caller goes away before the database answers.
	leave()
	assert.Equal(t, http.StatusServiceUnavailable, <-first, "a caller that went away gets no result")

	close(database.release)
	assert.Equal(t, http.StatusOK, <-second, "the other callers must get the ping's real result")
	assert.Equal(t, int64(1), database.calls.Load(), "the callers must have shared one ping")
}
