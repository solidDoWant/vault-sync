package server_test

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/version"
)

const getServerInfoPath = "/vaultsync.v1.ServerInfoService/GetServerInfo"

// reachableDatabase stands in for the PostgreSQL pool where a test is not
// about database reachability.
type reachableDatabase struct{}

func (reachableDatabase) Ping(context.Context) error { return nil }

// unreachableDatabase returns a real connection pool whose server does not
// exist: nothing listens on the port.
func unreachableDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	address := listener.Addr().String()
	require.NoError(t, listener.Close())

	pool, err := pgxpool.New(t.Context(), "postgres://vault_sync@"+address+"/vault_sync?sslmode=disable&connect_timeout=2")
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	return pool
}

func testOptions(options server.Options) server.Options {
	if options.MaxRequestBytes == 0 {
		options.MaxRequestBytes = 64 << 10
	}

	if options.ShutdownTimeout == 0 {
		options.ShutdownTimeout = 10 * time.Second
	}

	if options.Database == nil {
		options.Database = reachableDatabase{}
	}

	if options.Logger == nil {
		options.Logger = slog.New(slog.DiscardHandler)
	}

	return options
}

type runningServer struct {
	apiAddress     string
	metricsAddress string
	stop           context.CancelFunc
	// done is closed when Serve returns; err is then its result.
	done chan struct{}
	err  error
}

func (running *runningServer) apiURL() string { return "http://" + running.apiAddress }

func (running *runningServer) metricsURL() string { return "http://" + running.metricsAddress }

// startServer serves on loopback listeners until the test ends or stop is
// called.
func startServer(t *testing.T, options server.Options) *runningServer {
	t.Helper()

	apiListener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	metricsListener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	ctx, stop := context.WithCancel(t.Context())
	running := &runningServer{
		apiAddress:     apiListener.Addr().String(),
		metricsAddress: metricsListener.Addr().String(),
		stop:           stop,
		done:           make(chan struct{}),
	}

	srv := server.New(testOptions(options))

	go func() {
		running.err = srv.Serve(ctx, apiListener, metricsListener)
		close(running.done)
	}()

	t.Cleanup(func() {
		stop()
		<-running.done
	})

	return running
}

func get(t *testing.T, url string) (int, string) {
	t.Helper()

	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	require.NoError(t, err)

	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)

	return response.StatusCode, string(body)
}

func TestGetServerInfoRequiresNoAuthentication(t *testing.T) {
	running := startServer(t, server.Options{})

	client := vaultsyncv1connect.NewServerInfoServiceClient(http.DefaultClient, running.apiURL())

	response, err := client.GetServerInfo(t.Context(), connect.NewRequest(&vaultsyncv1.GetServerInfoRequest{}))
	require.NoError(t, err)

	assert.Equal(t, version.String(), response.Msg.GetVersion())
	assert.Equal(t, uint32(api.ProtocolVersion), response.Msg.GetProtocolVersion())
	assert.Equal(t, uint32(1), response.Msg.GetProtocolVersion())
}

func TestGetServerInfoAdvertisesTheIdentityProvider(t *testing.T) {
	tests := []struct {
		name         string
		issuer       string
		clientID     string
		wantClientID string
	}{
		{name: "issuer and client id", issuer: "https://auth.example/application/o/vault-sync/", clientID: "obsidian-plugin", wantClientID: "obsidian-plugin"},
		{name: "no client id advertised", issuer: "https://auth.example/", wantClientID: ""},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			running := startServer(t, server.Options{OIDCIssuerURL: test.issuer, OIDCClientID: test.clientID})

			client := vaultsyncv1connect.NewServerInfoServiceClient(http.DefaultClient, running.apiURL())

			// No Authorization header: signed-out clients discover the provider.
			response, err := client.GetServerInfo(t.Context(), connect.NewRequest(&vaultsyncv1.GetServerInfoRequest{}))
			require.NoError(t, err)

			assert.Equal(t, test.issuer, response.Msg.GetOidcIssuerUrl())
			assert.Equal(t, test.wantClientID, response.Msg.GetOidcClientId())
		})
	}
}

func TestGetServerInfoReportsTheRealtimeSubscriptionCap(t *testing.T) {
	tests := []struct {
		name    string
		hub     *realtime.Hub
		wantCap uint32
	}{
		{name: "realtime not served", wantCap: 0},
		{name: "default cap", hub: realtime.NewHub(realtime.Options{}), wantCap: realtime.DefaultMaxSubscriptions},
		{name: "configured cap", hub: realtime.NewHub(realtime.Options{Limits: realtime.Limits{MaxSubscriptions: 7}}), wantCap: 7},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			running := startServer(t, server.Options{Realtime: test.hub})

			client := vaultsyncv1connect.NewServerInfoServiceClient(http.DefaultClient, running.apiURL())

			response, err := client.GetServerInfo(t.Context(), connect.NewRequest(&vaultsyncv1.GetServerInfoRequest{}))
			require.NoError(t, err)
			assert.Equal(t, test.wantCap, response.Msg.GetMaxRealtimeSubscriptions())

			// The upgrade endpoint is served only with a hub; without a
			// token it is refused either way.
			status, _ := get(t, running.apiURL()+realtime.Path)
			if test.hub == nil {
				assert.Equal(t, http.StatusNotFound, status)
			} else {
				assert.Equal(t, http.StatusUnauthorized, status)
			}
		})
	}
}

func TestHealthz(t *testing.T) {
	// Liveness does not depend on the database.
	running := startServer(t, server.Options{Database: unreachableDatabase(t)})

	status, _ := get(t, running.metricsURL()+"/healthz")
	assert.Equal(t, http.StatusOK, status)
}

func TestReadyz(t *testing.T) {
	t.Run("database reachable", func(t *testing.T) {
		running := startServer(t, server.Options{Database: reachableDatabase{}})

		status, _ := get(t, running.metricsURL()+"/readyz")
		assert.Equal(t, http.StatusOK, status)
	})

	t.Run("database unreachable", func(t *testing.T) {
		running := startServer(t, server.Options{Database: unreachableDatabase(t)})

		status, _ := get(t, running.metricsURL()+"/readyz")
		assert.Equal(t, http.StatusServiceUnavailable, status)
	})
}

func TestMetricsAreServedOnTheSeparateMetricsPort(t *testing.T) {
	running := startServer(t, server.Options{})

	assert.NotEqual(t, running.apiAddress, running.metricsAddress)

	serverInfo := vaultsyncv1connect.NewServerInfoServiceClient(http.DefaultClient, running.apiURL())
	_, err := serverInfo.GetServerInfo(t.Context(), connect.NewRequest(&vaultsyncv1.GetServerInfoRequest{}))
	require.NoError(t, err)

	devices := vaultsyncv1connect.NewDeviceServiceClient(http.DefaultClient, running.apiURL())
	_, err = devices.RegisterDevice(t.Context(), connect.NewRequest(&vaultsyncv1.RegisterDeviceRequest{}))
	require.Error(t, err)

	status, body := get(t, running.metricsURL()+"/metrics")
	require.Equal(t, http.StatusOK, status)

	assert.Contains(t, body, "go_goroutines ")
	assert.Contains(t, body, "go_memstats_alloc_bytes ")
	assert.Contains(t, body, `vault_sync_rpc_requests_total{code="ok",procedure="/vaultsync.v1.ServerInfoService/GetServerInfo"} 1`)
	assert.Contains(t, body, `vault_sync_rpc_requests_total{code="unauthenticated",procedure="/vaultsync.v1.DeviceService/RegisterDevice"} 1`)
	assert.Contains(t, body, `vault_sync_rpc_request_duration_seconds_count{code="ok",procedure="/vaultsync.v1.ServerInfoService/GetServerInfo"} 1`)

	for _, path := range []string{"/metrics", "/healthz", "/readyz"} {
		status, _ := get(t, running.apiURL()+path)
		assert.Equal(t, http.StatusNotFound, status, "API port must not serve %s", path)
	}
}

func TestCORSPreflight(t *testing.T) {
	handler := server.New(testOptions(server.Options{})).Handler()

	tests := []struct {
		origin  string
		allowed bool
	}{
		{origin: "app://obsidian.md", allowed: true},
		{origin: "capacitor://localhost", allowed: true},
		{origin: "http://localhost", allowed: true},
		{origin: "https://evil.example", allowed: false},
		{origin: "http://localhost:8080", allowed: false},
		{origin: "https://localhost", allowed: false},
		{origin: "app://obsidian.md.evil.example", allowed: false},
		{origin: "null", allowed: false},
	}

	for _, test := range tests {
		t.Run(test.origin, func(t *testing.T) {
			request := httptest.NewRequestWithContext(t.Context(), http.MethodOptions, getServerInfoPath, nil)
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Access-Control-Request-Method", http.MethodPost)
			// Browsers send the requested header names lower-cased and sorted.
			request.Header.Set("Access-Control-Request-Headers", "authorization,connect-protocol-version,content-type")

			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			if !test.allowed {
				assert.Empty(t, recorder.Header().Get("Access-Control-Allow-Origin"))
				assert.Empty(t, recorder.Header().Get("Access-Control-Allow-Methods"))

				return
			}

			assert.Less(t, recorder.Code, 300)
			assert.Equal(t, test.origin, recorder.Header().Get("Access-Control-Allow-Origin"))
			assert.Contains(t, recorder.Header().Get("Access-Control-Allow-Methods"), http.MethodPost)

			allowedHeaders := strings.ToLower(recorder.Header().Get("Access-Control-Allow-Headers"))
			for _, header := range []string{"content-type", "connect-protocol-version", "authorization"} {
				assert.Contains(t, allowedHeaders, header)
			}
		})
	}
}

func TestCORSActualRequestFromObsidian(t *testing.T) {
	handler := server.New(testOptions(server.Options{})).Handler()

	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, getServerInfoPath, strings.NewReader("{}"))
	request.Header.Set("Origin", "app://obsidian.md")
	request.Header.Set("Content-Type", "application/json")

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "app://obsidian.md", recorder.Header().Get("Access-Control-Allow-Origin"))
}

// errReadPastCap is returned by a countingReader read past its cap.
var errReadPastCap = errors.New("test body read past its cap")

// countingReader yields a stream of zero bytes, counting how many were read.
// After cap bytes (when cap is positive) it fails instead, so a server that
// reads without bound fails the test at once instead of hanging it.
type countingReader struct {
	cap  int64
	read atomic.Int64
}

func (reader *countingReader) Read(buffer []byte) (int, error) {
	if reader.cap > 0 {
		remaining := reader.cap - reader.read.Load()
		if remaining <= 0 {
			return 0, errReadPastCap
		}

		buffer = buffer[:min(int64(len(buffer)), remaining)]
	}

	clear(buffer)
	reader.read.Add(int64(len(buffer)))

	return len(buffer), nil
}

// connectErrorCode extracts the code from a Connect unary error body.
func connectErrorCode(t *testing.T, body []byte) string {
	t.Helper()

	var payload struct {
		Code string `json:"code"`
	}

	require.NoError(t, json.Unmarshal(body, &payload), "body: %s", body)

	return payload.Code
}

func TestRequestBodyLimit(t *testing.T) {
	const (
		maxRequestBytes = 64 << 10
		// bodyCap is far more than a bounded server reads, but small enough
		// that an unbounded one reaches it at once.
		bodyCap = 16 * maxRequestBytes
	)

	handler := server.New(testOptions(server.Options{MaxRequestBytes: maxRequestBytes})).Handler()

	newRequest := func(t *testing.T, body io.Reader) *http.Request {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, getServerInfoPath, body)
		request.Header.Set("Content-Type", "application/proto")

		return request
	}

	t.Run("declared length over the limit is rejected without reading", func(t *testing.T) {
		body := &countingReader{cap: bodyCap}
		request := newRequest(t, body)
		request.ContentLength = maxRequestBytes + 1

		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		assert.Equal(t, http.StatusRequestEntityTooLarge, recorder.Code)
		assert.Zero(t, body.read.Load())
	})

	t.Run("streamed body over the limit is rejected after reading about the limit", func(t *testing.T) {
		body := &countingReader{cap: bodyCap}
		request := newRequest(t, body)
		require.Equal(t, int64(-1), request.ContentLength)

		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		// Readers may over-read by a buffer, but never buffer the whole body.
		require.LessOrEqual(t, body.read.Load(), int64(maxRequestBytes+64<<10))
		assert.Equal(t, "resource_exhausted", connectErrorCode(t, recorder.Body.Bytes()))
	})

	t.Run("compressed body that inflates over the limit is rejected", func(t *testing.T) {
		var compressed bytes.Buffer

		writer := gzip.NewWriter(&compressed)
		_, err := writer.Write(make([]byte, 16*maxRequestBytes))
		require.NoError(t, err)
		require.NoError(t, writer.Close())
		require.Less(t, compressed.Len(), maxRequestBytes)

		request := newRequest(t, &compressed)
		request.Header.Set("Content-Encoding", "gzip")

		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		assert.Equal(t, "resource_exhausted", connectErrorCode(t, recorder.Body.Bytes()))
	})

	t.Run("body within the limit is accepted", func(t *testing.T) {
		// Field 15, length-delimited: an unknown field the server ignores.
		padding := make([]byte, maxRequestBytes-8)
		message := append([]byte{0x7a}, protowireLength(len(padding))...)
		message = append(message, padding...)
		require.LessOrEqual(t, len(message), maxRequestBytes)

		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, newRequest(t, bytes.NewReader(message)))

		assert.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	})
}

func protowireLength(length int) []byte {
	var varint []byte

	for length >= 0x80 {
		varint = append(varint, byte(length)|0x80)
		length >>= 7
	}

	return append(varint, byte(length))
}

// slowRequest is a GetServerInfo request whose handler is running and
// waiting for the rest of its body.
type slowRequest struct {
	conn   net.Conn
	reader *bufio.Reader
}

// startSlowRequest sends GetServerInfo headers with "Expect: 100-continue"
// and returns once the server answers "100 Continue", which it does only when
// the handler starts reading the body: the request is then in flight.
func startSlowRequest(t *testing.T, address string) *slowRequest {
	t.Helper()

	conn, err := net.Dial("tcp", address)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	_, err = fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: vault-sync\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n", getServerInfoPath)
	require.NoError(t, err)

	require.NoError(t, conn.SetReadDeadline(time.Now().Add(10*time.Second)))

	reader := bufio.NewReader(conn)

	status, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "HTTP/1.1 100 Continue\r\n", status)

	blank, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "\r\n", blank)

	require.NoError(t, conn.SetReadDeadline(time.Time{}))

	return &slowRequest{conn: conn, reader: reader}
}

// finish sends the two-byte JSON body and reads the response.
func (request *slowRequest) finish(t *testing.T) (int, string) {
	t.Helper()

	_, err := request.conn.Write([]byte("{}"))
	require.NoError(t, err)

	response, err := http.ReadResponse(request.reader, nil)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)

	return response.StatusCode, string(body)
}

func requireRefusesConnections(t *testing.T, address string) {
	t.Helper()

	require.Eventually(t, func() bool {
		conn, err := net.DialTimeout("tcp", address, time.Second)
		if err != nil {
			return true
		}

		_ = conn.Close()

		return false
	}, 5*time.Second, 10*time.Millisecond, "server must stop accepting connections")
}

func TestShutdownDrainsInFlightRequests(t *testing.T) {
	running := startServer(t, server.Options{ShutdownTimeout: 10 * time.Second})

	inFlight := startSlowRequest(t, running.apiAddress)

	running.stop()
	requireRefusesConnections(t, running.apiAddress)

	// While draining the server reports itself not ready.
	status, _ := get(t, running.metricsURL()+"/readyz")
	assert.Equal(t, http.StatusServiceUnavailable, status)

	select {
	case <-running.done:
		t.Fatalf("server stopped before the in-flight request finished: %v", running.err)
	default:
	}

	status, body := inFlight.finish(t)
	assert.Equal(t, http.StatusOK, status, body)
	assert.Contains(t, body, `"protocolVersion":1`)

	select {
	case <-running.done:
		require.NoError(t, running.err)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop after draining")
	}
}

func TestShutdownGivesUpAfterTimeout(t *testing.T) {
	const shutdownTimeout = 300 * time.Millisecond

	running := startServer(t, server.Options{ShutdownTimeout: shutdownTimeout})

	stuck := startSlowRequest(t, running.apiAddress)

	started := time.Now()

	running.stop()

	select {
	case <-running.done:
		require.ErrorIs(t, running.err, context.DeadlineExceeded)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop within the shutdown timeout")
	}

	assert.GreaterOrEqual(t, time.Since(started), shutdownTimeout)

	// The stuck connection was closed rather than left open.
	require.NoError(t, stuck.conn.SetReadDeadline(time.Now().Add(5*time.Second)))

	_, err := stuck.reader.ReadByte()
	require.Error(t, err)

	var netErr net.Error
	if errors.As(err, &netErr) {
		assert.False(t, netErr.Timeout(), "connection must be closed, not left open")
	}
}

func TestShutdownFailsReadinessBeforeRefusingConnections(t *testing.T) {
	// Generous, so the readiness poll and the request below fit within the
	// delay even on a loaded machine.
	const shutdownDelay = 3 * time.Second

	running := startServer(t, server.Options{ShutdownDelay: shutdownDelay})

	status, _ := get(t, running.metricsURL()+"/readyz")
	require.Equal(t, http.StatusOK, status)

	started := time.Now()

	running.stop()

	require.Eventually(t, func() bool {
		status, _ := get(t, running.metricsURL()+"/readyz")

		return status == http.StatusServiceUnavailable
	}, 5*time.Second, 10*time.Millisecond, "readiness must fail as soon as shutdown starts")

	// Readiness fails while the API still serves new connections, so load
	// balancers stop routing here before any request is refused. Responses
	// close their connection, so clients reconnect elsewhere.
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, running.apiURL()+getServerInfoPath, strings.NewReader("{}"))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")

	response, err := (&http.Client{Transport: &http.Transport{}}).Do(request)
	require.NoError(t, err, "the API must accept requests during the shutdown delay")

	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()

	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.True(t, response.Close, "responses during the shutdown delay must close their connection")
	assert.Less(t, time.Since(started), shutdownDelay, "the request must have been served during the delay")

	requireRefusesConnections(t, running.apiAddress)
	assert.GreaterOrEqual(t, time.Since(started), shutdownDelay)

	select {
	case <-running.done:
		require.NoError(t, running.err)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
}

// A client may be reusing a kept-alive connection at the moment shutdown
// starts, before any load balancer has noticed. Its request must be served,
// not reset (issue #154): the server closes the connection only after
// answering, so the client reconnects to another instance.
func TestShutdownServesRequestsOnConnectionsIdleWhenShutdownStarts(t *testing.T) {
	// Generous, so the request lands within the delay even on a loaded
	// machine; the test waits for it only once, at cleanup.
	const shutdownDelay = 3 * time.Second

	running := startServer(t, server.Options{ShutdownDelay: shutdownDelay})

	conn, err := net.Dial("tcp", running.apiAddress)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	require.NoError(t, conn.SetDeadline(time.Now().Add(30*time.Second)))

	reader := bufio.NewReader(conn)

	serverInfo := func() (*http.Response, error) {
		_, err := fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: vault-sync\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}", getServerInfoPath)
		if err != nil {
			return nil, err
		}

		response, err := http.ReadResponse(reader, nil)
		if err != nil {
			return nil, err
		}

		_, err = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()

		return response, err
	}

	response, err := serverInfo()
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	require.False(t, response.Close, "the connection is kept alive before shutdown")

	// The connection is now idle on the server. Shutdown starts.
	running.stop()

	require.Eventually(t, func() bool {
		status, _ := get(t, running.metricsURL()+"/readyz")

		return status == http.StatusServiceUnavailable
	}, 5*time.Second, 10*time.Millisecond, "readiness must fail as soon as shutdown starts")

	response, err = serverInfo()
	require.NoError(t, err, "a request on a connection idle when shutdown started must be served")
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.True(t, response.Close, "responses during the shutdown delay must close their connection")

	select {
	case <-running.done:
		t.Fatalf("server stopped before the shutdown delay ended: %v", running.err)
	default:
	}
}

// fakeDrainer stands in for an owner of long-lived connections (the
// realtime hub's WebSockets).
type fakeDrainer struct {
	metricsURL func() string
	// readiness is the /readyz status seen when Drain was called.
	readiness atomic.Int32
	// hasDeadline reports whether Drain's context had a deadline.
	hasDeadline atomic.Bool
	called      chan struct{}
	release     chan struct{}
	err         error
}

func newFakeDrainer() *fakeDrainer {
	return &fakeDrainer{called: make(chan struct{}), release: make(chan struct{})}
}

func (drainer *fakeDrainer) Drain(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, drainer.metricsURL()+"/readyz", nil)
	if err == nil {
		if response, err := http.DefaultClient.Do(request); err == nil {
			drainer.readiness.Store(int32(response.StatusCode))
			_ = response.Body.Close()
		}
	}

	_, ok := ctx.Deadline()
	drainer.hasDeadline.Store(ok)
	close(drainer.called)

	select {
	case <-drainer.release:
		return drainer.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestShutdownDrainsLongLivedConnectionsAfterReadinessFails(t *testing.T) {
	drainer := newFakeDrainer()

	running := startServer(t, server.Options{Drainers: []server.Drainer{drainer}})
	drainer.metricsURL = running.metricsURL

	running.stop()

	select {
	case <-drainer.called:
	case <-time.After(5 * time.Second):
		t.Fatal("drainer was not called on shutdown")
	}

	assert.Equal(t, int32(http.StatusServiceUnavailable), drainer.readiness.Load(), "readiness must fail before connections are drained")
	assert.True(t, drainer.hasDeadline.Load(), "draining must be bounded by the shutdown timeout")

	select {
	case <-running.done:
		t.Fatal("server stopped before the drainer finished")
	case <-time.After(100 * time.Millisecond):
	}

	close(drainer.release)

	select {
	case <-running.done:
		require.NoError(t, running.err)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop after draining")
	}
}

func TestShutdownReportsDrainerFailures(t *testing.T) {
	failure := errors.New("close failed")

	tests := []struct {
		name    string
		timeout time.Duration
		release bool
		err     error
		want    error
	}{
		{name: "drainer fails", timeout: 10 * time.Second, release: true, err: failure, want: failure},
		{name: "drainer exceeds the shutdown timeout", timeout: 200 * time.Millisecond, want: context.DeadlineExceeded},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			drainer := newFakeDrainer()
			drainer.err = test.err

			running := startServer(t, server.Options{ShutdownTimeout: test.timeout, Drainers: []server.Drainer{drainer}})
			drainer.metricsURL = running.metricsURL

			running.stop()
			<-drainer.called

			if test.release {
				close(drainer.release)
			}

			select {
			case <-running.done:
			case <-time.After(5 * time.Second):
				t.Fatal("server did not stop")
			}

			require.ErrorIs(t, running.err, test.want)
		})
	}
}
