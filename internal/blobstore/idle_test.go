package blobstore

import (
	"io"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestIdleConnWaitsForAResponseWhileTheRequestIsStillBeingSent proves that
// a request body that keeps moving extends the deadline of the read that
// waits for the response: the transport starts that read before it sends
// the request.
func TestIdleConnWaitsForAResponseWhileTheRequestIsStillBeingSent(t *testing.T) {
	// The peer reads slices with pauses far shorter than the timeout,
	// taking several timeouts in all.
	const (
		timeout = 500 * time.Millisecond
		slices  = 300
	)

	client, peer := net.Pipe()

	t.Cleanup(func() { _ = client.Close() })
	t.Cleanup(func() { _ = peer.Close() })

	conn := &idleConn{Conn: client, timeout: timeout}

	response := make(chan error, 1)

	go func() {
		buffer := make([]byte, 2)

		_, err := io.ReadFull(conn, buffer)
		response <- err
	}()

	go func() {
		buffer := make([]byte, idleWriteSlice)

		for range slices {
			time.Sleep(timeout / 100)

			if _, err := io.ReadFull(peer, buffer); err != nil {
				return
			}
		}

		_, _ = peer.Write([]byte("ok"))
	}()

	written, err := conn.Write(make([]byte, slices*idleWriteSlice))
	require.NoError(t, err)
	assert.Equal(t, slices*idleWriteSlice, written)

	select {
	case err := <-response:
		require.NoError(t, err)
	case <-time.After(time.Minute):
		require.FailNow(t, "no response")
	}
}
