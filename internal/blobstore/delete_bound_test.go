package blobstore_test

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// drippingEndpoint returns the URL of an "object store" that reads each
// request and then sends its response headers one byte at a time, a byte
// every few milliseconds, forever: the connection always makes progress,
// so its idle timeout never fires.
func drippingEndpoint(t *testing.T) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	stop := make(chan struct{})

	t.Cleanup(func() {
		close(stop)

		_ = listener.Close()
	})

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}

			go func() {
				defer func() { _ = conn.Close() }()

				if _, err := http.ReadRequest(bufio.NewReader(conn)); err != nil {
					return
				}

				if _, err := conn.Write([]byte("HTTP/1.1 204 No Content\r\nX-Drip: ")); err != nil {
					return
				}

				ticker := time.NewTicker(testIdleTimeout / 10)
				defer ticker.Stop()

				for {
					select {
					case <-stop:
						return
					case <-ticker.C:
					}

					if _, err := conn.Write([]byte("x")); err != nil {
						return
					}
				}
			}()
		}
	}()

	return "http://" + listener.Addr().String()
}

// #225 item 6: a store that keeps dripping response bytes never trips the
// idle timeout, so Delete bounds the whole call: the retention job deletes
// an object while holding the lock a re-upload of the blob waits for.
func TestDeleteFromAStoreThatDripsForeverIsBounded(t *testing.T) {
	objects := objectsAt(t, drippingEndpoint(t), testIdleTimeout, 1)

	err := returnsWithin(t, func() error { return objects.Delete(t.Context(), "vaults/x/blobs/00") })
	require.ErrorIs(t, err, context.DeadlineExceeded)
}
