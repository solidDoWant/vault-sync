package blobstore_test

import (
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The SDK's standard retryer makes 3 attempts; blobstore's retryer only adds
// a check for permanent certificate errors in front of the standard checks.
const defaultAttempts = 3

func TestTransientStoreErrorsAreRetried(t *testing.T) {
	t.Run("503 answers", func(t *testing.T) {
		var requests atomic.Int64

		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			requests.Add(1)
			writer.WriteHeader(http.StatusServiceUnavailable)
		}))
		t.Cleanup(server.Close)

		// Default retry settings: no per-operation override.
		objects := newTLSObjects(t, server.URL, "")

		require.Error(t, objects.Check(t.Context()))
		assert.Equal(t, int64(defaultAttempts), requests.Load(), "requests attempted")
	})

	t.Run("reset connections", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		require.NoError(t, err)
		t.Cleanup(func() { _ = listener.Close() })

		var connections atomic.Int64

		go func() {
			for {
				connection, err := listener.Accept()
				if err != nil {
					return
				}

				connections.Add(1)

				// Linger 0 closes with a reset instead of a FIN.
				if tcp, ok := connection.(*net.TCPConn); ok {
					_ = tcp.SetLinger(0)
				}

				_ = connection.Close()
			}
		}()

		objects := newTLSObjects(t, "http://"+listener.Addr().String(), "")

		require.Error(t, objects.Check(t.Context()))
		assert.Equal(t, int64(defaultAttempts), connections.Load(), "connections attempted")
	})
}

func TestStoreRequestsUseHTTP1EvenWhenTheStoreOffersHTTP2(t *testing.T) {
	var protocols atomic.Int64

	var other atomic.Value

	server := httptest.NewUnstartedServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		if request.ProtoMajor == 1 {
			protocols.Add(1)
		} else {
			other.Store(request.Proto)
		}
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)

	caFile := filepath.Join(t.TempDir(), "ca.pem")
	writeTestFile(t, caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}))

	objects := newTLSObjects(t, server.URL, caFile)

	require.NoError(t, objects.Check(t.Context()))
	assert.Nil(t, other.Load(), "a request used another protocol than HTTP/1")
	assert.Positive(t, protocols.Load())
}

