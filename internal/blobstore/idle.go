package blobstore

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"
)

// idleWriteSlice bounds one write to the underlying connection, so that a
// large write that keeps making progress keeps extending the deadline.
const idleWriteSlice = 64 << 10

// boundIdleConnections makes every connection transport opens fail a request
// that makes no progress, in either direction, for timeout.
//
// This bounds every object-store call against a store that accepts a
// connection and then stops answering, stops reading the request, or stalls
// in the response body, without a wall-clock cap on the call: a slow
// transfer that keeps moving (a multipart part, a long streamed read) is
// never cut short, and the SDK retries an attempt that timed out a bounded
// number of times.
func boundIdleConnections(transport *http.Transport, timeout time.Duration) {
	// One request per connection (HTTP/1.1), so the idle timeout applies to
	// exactly one request. S3 APIs are served over HTTP/1.1.
	transport.ForceAttemptHTTP2 = false
	transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}

	// Close pooled connections before their idle deadline would: a request
	// never picks up a connection that is about to time out.
	if transport.IdleConnTimeout <= 0 || transport.IdleConnTimeout > timeout/2 {
		transport.IdleConnTimeout = timeout / 2
	}

	dial := transport.DialContext
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}

	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dial(ctx, network, address)
		if err != nil {
			return nil, err
		}

		return &idleConn{Conn: conn, timeout: timeout}, nil
	}
}

// idleConn fails a read or write once the connection has made no progress
// in either direction for timeout. Every read or write, and every part of a
// write that completes, pushes the deadline of both directions forward: the
// transport's reader waits for the response while the request body is still
// being sent, and must not time out while that progresses.
type idleConn struct {
	net.Conn
	timeout time.Duration
}

func (conn *idleConn) extend() {
	// Errors surface on the following read or write.
	_ = conn.SetDeadline(time.Now().Add(conn.timeout))
}

// Read implements io.Reader.
func (conn *idleConn) Read(buffer []byte) (int, error) {
	conn.extend()

	read, err := conn.Conn.Read(buffer)

	return read, conn.explain(err)
}

// Write implements io.Writer.
func (conn *idleConn) Write(buffer []byte) (int, error) {
	written := 0

	for written < len(buffer) {
		conn.extend()

		count, err := conn.Conn.Write(buffer[written:min(len(buffer), written+idleWriteSlice)])
		written += count

		if err != nil {
			return written, conn.explain(err)
		}
	}

	return written, nil
}

// explain names the idle timeout in a deadline error, which then shows in
// the logs of the failed call.
func (conn *idleConn) explain(err error) error {
	if err == nil || !errors.Is(err, os.ErrDeadlineExceeded) {
		return err
	}

	return &idleTimeoutError{timeout: conn.timeout, err: err}
}

// idleTimeoutError is a connection's idle timeout. Its Timeout method reports
// true, so the SDK retries the attempt.
type idleTimeoutError struct {
	timeout time.Duration
	err     error
}

func (err *idleTimeoutError) Error() string {
	return fmt.Sprintf("object store connection made no progress for %s: %v", err.timeout, err.err)
}

func (err *idleTimeoutError) Unwrap() error { return err.err }

// Timeout reports that the error is a timeout, as net.Error does.
func (*idleTimeoutError) Timeout() bool { return true }
