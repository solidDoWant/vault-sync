package server

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #166: whether a response closes its connection is decided when its header
// is written, so a request in flight when shutdown starts closes it too.
func TestResponsesWrittenWhileDrainingCloseTheirConnection(t *testing.T) {
	tests := []struct {
		name string
		// respond writes the response once shutdown has started.
		respond   func(writer http.ResponseWriter)
		wantClose bool
	}{
		{name: "body", respond: func(writer http.ResponseWriter) { _, _ = writer.Write([]byte("ok")) }, wantClose: true},
		{name: "status", respond: func(writer http.ResponseWriter) { writer.WriteHeader(http.StatusNoContent) }, wantClose: true},
		{name: "flush", respond: func(writer http.ResponseWriter) {
			require.NoError(t, http.NewResponseController(writer).Flush())
		}, wantClose: true},
		{name: "flusher", respond: func(writer http.ResponseWriter) {
			flusher, ok := writer.(http.Flusher)
			require.True(t, ok)
			flusher.Flush()
		}, wantClose: true},
		{
			// A refused WebSocket upgrade sets its own Connection header.
			name: "refused upgrade",
			respond: func(writer http.ResponseWriter) {
				writer.Header().Set("Connection", "Upgrade")
				writer.WriteHeader(http.StatusUpgradeRequired)
			},
			wantClose: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			srv := &Server{}
			started := make(chan struct{})
			proceed := make(chan struct{})

			handler := srv.closeConnectionsWhileDraining(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				close(started)
				<-proceed
				test.respond(writer)
			}))

			server := httptest.NewServer(handler)
			t.Cleanup(server.Close)

			responses := make(chan *http.Response, 1)

			go func() {
				request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL, nil)
				if !assert.NoError(t, err) {
					close(responses)

					return
				}

				response, err := server.Client().Do(request)
				if !assert.NoError(t, err) {
					close(responses)

					return
				}

				_ = response.Body.Close()
				responses <- response
			}()

			// The request is in flight when shutdown starts.
			<-started
			srv.draining.Store(true)
			close(proceed)

			response, ok := <-responses
			require.True(t, ok)
			assert.Equal(t, test.wantClose, response.Close)
		})
	}
}

func TestResponsesWrittenBeforeDrainingKeepTheirConnection(t *testing.T) {
	srv := &Server{}
	server := httptest.NewServer(srv.closeConnectionsWhileDraining(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte("ok"))
	})))
	t.Cleanup(server.Close)

	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL, nil)
	require.NoError(t, err)

	response, err := server.Client().Do(request)
	require.NoError(t, err)

	_ = response.Body.Close()

	assert.False(t, response.Close)
}

// A WebSocket upgrade accepted while draining keeps its own Connection:
// Upgrade header, so the handshake succeeds; only the realtime hub decides
// when to close the connection (#443).
func TestWebSocketUpgradeAcceptedWhileDrainingSucceeds(t *testing.T) {
	srv := &Server{}
	srv.draining.Store(true)

	server := httptest.NewServer(srv.closeConnectionsWhileDraining(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		conn, err := websocket.Accept(writer, request, nil)
		if !assert.NoError(t, err) {
			return
		}

		_ = conn.Close(websocket.StatusNormalClosure, "")
	})))
	t.Cleanup(server.Close)

	conn, response, err := websocket.Dial(t.Context(), server.URL, nil)
	require.NoError(t, err)

	t.Cleanup(func() { _ = conn.CloseNow() })

	assert.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)
	assert.Equal(t, "Upgrade", response.Header.Get("Connection"))
}

// failingFlusher is a response writer whose flush fails, as one to a client
// that has gone does.
type failingFlusher struct {
	http.ResponseWriter

	err error
}

func (writer failingFlusher) FlushError() error { return writer.err }

// http.ResponseController.Flush on the wrapper returns the wrapped writer's
// flush error instead of hiding it (#443).
func TestDrainingWriterReportsFlushErrors(t *testing.T) {
	gone := errors.New("client gone")

	for _, draining := range []bool{false, true} {
		t.Run(fmt.Sprintf("draining=%t", draining), func(t *testing.T) {
			recorder := httptest.NewRecorder()
			flag := &atomic.Bool{}
			flag.Store(draining)

			writer := &drainingWriter{ResponseWriter: failingFlusher{ResponseWriter: recorder, err: gone}, draining: flag}

			require.ErrorIs(t, http.NewResponseController(writer).Flush(), gone)
			assert.Equal(t, http.StatusOK, recorder.Code, "the header is written first")
			assert.Equal(t, draining, recorder.Header().Get("Connection") == "close")
		})
	}
}
