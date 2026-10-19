package server_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/coder/websocket"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// largeVaults is a vault store whose ListVaults returns one vault with a
// name of whatever length the test sets, so the response can be made as
// large as needed. Names that long are never stored for real; the store is
// a stand-in for any handler producing a large response.
type largeVaults struct {
	nameLength atomic.Int64
	// delay is how long ListVaults takes before it returns. It ends early,
	// with the context's error, if the request context ends first.
	delay time.Duration
}

func (vaults *largeVaults) CreateVault(context.Context, uuid.UUID, store.NewVault, int) (store.Vault, error) {
	return store.Vault{}, errors.New("not supported")
}

func (vaults *largeVaults) ListVaults(ctx context.Context, _, _ uuid.UUID, _ int) ([]store.Vault, error) {
	if vaults.delay > 0 {
		select {
		case <-time.After(vaults.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	return []store.Vault{{
		ID:         uuid.MustParse("0192f7a0-0000-7000-8000-000000000000"),
		Name:       strings.Repeat("a", int(vaults.nameLength.Load())),
		Encryption: store.EncryptionNone,
		Role:       store.RoleOwner,
		CreatedAt:  time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}}, nil
}

// newLargeResponseFixture serves vaults through an authenticated server
// configured by options.
func newLargeResponseFixture(t *testing.T, vaults *largeVaults, options server.Options) (*authFixture, string) {
	t.Helper()

	issuer := authtest.NewIssuer(t)
	fixture := &authFixture{issuer: issuer, key: issuer.AddKey(t, jose.RS256), logs: &syncBuffer{}}
	logger := slog.New(slog.NewJSONHandler(fixture.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))

	verifier := auth.NewVerifier(auth.VerifierOptions{
		IssuerURL: issuer.URL,
		Audience:  authtest.DefaultAudience,
		Logger:    logger,
	})

	options.Authenticator = auth.NewAuthenticator(verifier, newMemoryStore())
	options.Vaults = vaults
	options.Logger = logger
	fixture.running = startServer(t, options)

	return fixture, fixture.token(t, "large-response-user")
}

// nameLengthForResponseSize returns the vault name length that makes the
// encoded ListVaults response exactly size bytes.
func nameLengthForResponseSize(t *testing.T, template *vaultsyncv1.ListVaultsResponse, size int) int {
	t.Helper()

	response := proto.CloneOf(template)
	require.Len(t, response.GetVaults(), 1)

	for length := size; length > 0; length-- {
		response.GetVaults()[0].Name = strings.Repeat("a", length)
		if proto.Size(response) == size {
			return length
		}
	}

	require.FailNow(t, "no name length gives the response size", "size %d", size)

	return 0
}

func TestResponsesOverTheSendLimitAreRejected(t *testing.T) {
	const maxBytes = 64 << 10

	vaults := &largeVaults{}
	fixture, token := newLargeResponseFixture(t, vaults, server.Options{MaxRequestBytes: maxBytes})
	client := vaultsyncv1connect.NewVaultServiceClient(http.DefaultClient, fixture.running.apiURL())

	vaults.nameLength.Store(1)

	template, err := client.ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{}, token))
	require.NoError(t, err)

	tests := []struct {
		name        string
		size        int
		assertError require.ErrorAssertionFunc
	}{
		{name: "exactly the limit", size: maxBytes, assertError: require.NoError},
		{
			name: "one byte over the limit",
			size: maxBytes + 1,
			assertError: func(t require.TestingT, err error, _ ...any) {
				require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err), "error: %v", err)
			},
		},
	}

	// The limit applies to the bytes sent. Without compression these are
	// the binary protobuf message, whose size the test controls exactly.
	uncompressed := vaultsyncv1connect.NewVaultServiceClient(http.DefaultClient, fixture.running.apiURL(), connect.WithAcceptCompression("gzip", nil, nil))

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			vaults.nameLength.Store(int64(nameLengthForResponseSize(t, template.Msg, test.size)))

			response, err := uncompressed.ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{}, token))
			test.assertError(t, err)

			if err == nil {
				assert.Equal(t, test.size, proto.Size(response.Msg))
			}
		})
	}
}

func TestHandlersMayRunLongerThanTheWriteTimeout(t *testing.T) {
	const writeTimeout = 200 * time.Millisecond

	// The handler takes several write timeouts (a long blob commit, say),
	// then writes a small response, which must reach the client: the
	// timeout bounds writing the response, not producing it.
	vaults := &largeVaults{delay: 5 * writeTimeout}
	vaults.nameLength.Store(16)
	fixture, token := newLargeResponseFixture(t, vaults, server.Options{WriteTimeout: writeTimeout})
	client := vaultsyncv1connect.NewVaultServiceClient(http.DefaultClient, fixture.running.apiURL())

	started := time.Now()
	response, err := client.ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{}, token))
	require.NoError(t, err, "a handler that runs longer than the write timeout must still deliver its response")
	require.GreaterOrEqual(t, time.Since(started), vaults.delay)
	require.Len(t, response.Msg.GetVaults(), 1)
	assert.Equal(t, strings.Repeat("a", 16), response.Msg.GetVaults()[0].GetName())
}

func TestServerReleasesConnectionsOfClientsThatDoNotRead(t *testing.T) {
	const (
		writeTimeout = 300 * time.Millisecond
		// Far more than the kernel buffers on both ends of the connection
		// hold, so the server blocks writing until the client reads.
		responseBytes = 24 << 20
	)

	vaults := &largeVaults{}
	vaults.nameLength.Store(responseBytes)
	fixture, token := newLargeResponseFixture(t, vaults, server.Options{
		MaxRequestBytes: 32 << 20,
		WriteTimeout:    writeTimeout,
	})

	conn, err := net.Dial("tcp", fixture.running.apiAddress)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	_, err = fmt.Fprintf(conn, "POST /vaultsync.v1.VaultService/ListVaults HTTP/1.1\r\nHost: vault-sync\r\n"+
		"Authorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}", token)
	require.NoError(t, err)

	// Wait for the response's first bytes (the read deadline only keeps a
	// broken server from hanging the test). The server set its write
	// deadline before writing them, so it has passed once the client then
	// stays idle for longer than writeTimeout.
	reader := bufio.NewReader(conn)

	require.NoError(t, conn.SetReadDeadline(time.Now().Add(30*time.Second)))

	_, err = reader.Peek(1)
	require.NoError(t, err, "the server must start the response")

	time.Sleep(3 * writeTimeout)

	// Reading now gets what the kernel buffered, then the closed connection
	// instead of the rest of the response.
	response, err := http.ReadResponse(reader, nil)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	require.Equal(t, http.StatusOK, response.StatusCode)

	read, err := io.Copy(io.Discard, response.Body)
	require.Error(t, err, "the server must not deliver the whole response to a client that stopped reading")
	assert.Less(t, read, int64(responseBytes))

	var netErr net.Error
	if errors.As(err, &netErr) {
		assert.False(t, netErr.Timeout(), "the server must close the connection, not leave it open")
	}
}

// slowDatabase is a database whose pings block until their context ends,
// recording how many run at once. A second concurrent ping ends them all at
// once, so a server that pings without bound fails the test quickly.
type slowDatabase struct {
	mu          sync.Mutex
	inFlight    int
	maxInFlight int
	calls       int
	overlapped  chan struct{}
	overlap     bool
	// healthy makes pings succeed at once.
	healthy atomic.Bool
}

func newSlowDatabase() *slowDatabase {
	return &slowDatabase{overlapped: make(chan struct{})}
}

func (database *slowDatabase) Ping(ctx context.Context) error {
	if database.healthy.Load() {
		return nil
	}

	database.mu.Lock()
	database.inFlight++
	database.calls++
	database.maxInFlight = max(database.maxInFlight, database.inFlight)

	if database.inFlight > 1 && !database.overlap {
		database.overlap = true
		close(database.overlapped)
	}
	database.mu.Unlock()

	defer func() {
		database.mu.Lock()
		database.inFlight--
		database.mu.Unlock()
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-database.overlapped:
		return errors.New("concurrent ping")
	}
}

func (database *slowDatabase) stats() (maxInFlight, calls int) {
	database.mu.Lock()
	defer database.mu.Unlock()

	return database.maxInFlight, database.calls
}

func TestReadyzHoldsAtMostOneDatabaseConnection(t *testing.T) {
	const requests = 20

	database := newSlowDatabase()
	running := startServer(t, server.Options{Database: database})

	statuses := make(chan int, requests)

	var group sync.WaitGroup

	for range requests {
		group.Go(func() {
			request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, running.metricsURL()+"/readyz", nil)
			if err != nil {
				statuses <- 0

				return
			}

			response, err := (&http.Client{Transport: &http.Transport{}, Timeout: 30 * time.Second}).Do(request)
			if err != nil {
				statuses <- 0

				return
			}

			_ = response.Body.Close()
			statuses <- response.StatusCode
		})
	}

	group.Wait()
	close(statuses)

	for status := range statuses {
		assert.Equal(t, http.StatusServiceUnavailable, status, "a slow database must make /readyz fail")
	}

	maxInFlight, calls := database.stats()
	assert.Equal(t, 1, maxInFlight, "concurrent /readyz calls must share one database ping")
	assert.GreaterOrEqual(t, calls, 1)

	// The failure is not remembered: once the database recovers, the next
	// check reports ready.
	database.healthy.Store(true)

	status, _ := get(t, running.metricsURL()+"/readyz")
	assert.Equal(t, http.StatusOK, status)
}

// idleRealtimeStore is a realtime store in which every caller owns every
// vault and no commits happen.
type idleRealtimeStore struct{}

func (idleRealtimeStore) VaultMembers(_ context.Context, _ uuid.UUID, userIDs []uuid.UUID) (map[uuid.UUID]bool, error) {
	members := make(map[uuid.UUID]bool, len(userIDs))
	for _, userID := range userIDs {
		members[userID] = true
	}

	return members, nil
}

func (idleRealtimeStore) MemberHeadSeq(context.Context, uuid.UUID, uuid.UUID) (store.Role, int64, error) {
	return store.RoleOwner, 0, nil
}

func (idleRealtimeStore) HeadSeqs(context.Context, []uuid.UUID) (map[uuid.UUID]int64, error) {
	return map[uuid.UUID]int64{}, nil
}

func (idleRealtimeStore) ListenVaultChanges(ctx context.Context, options store.ListenOptions) error {
	options.Ready(ctx)
	<-ctx.Done()

	return nil
}

// idleHub is a running realtime hub over idleRealtimeStore, with the
// authenticator it checks upgrades against and a token it accepts.
type idleHub struct {
	hub           *realtime.Hub
	authenticator *auth.Authenticator
	token         string
}

func startIdleHub(t *testing.T, logger *slog.Logger) idleHub {
	t.Helper()

	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.RS256)
	authenticator := auth.NewAuthenticator(auth.NewVerifier(auth.VerifierOptions{
		IssuerURL: issuer.URL,
		Audience:  authtest.DefaultAudience,
		Logger:    logger,
	}), newMemoryStore())

	hub := realtime.NewHub(realtime.Options{
		Authenticator:  authenticator,
		Store:          idleRealtimeStore{},
		AllowedOrigins: server.AllowedOrigins,
		Logger:         logger,
	})

	hubCtx, stopHub := context.WithCancel(t.Context())
	hubDone := make(chan struct{})

	go func() {
		defer close(hubDone)

		hub.Run(hubCtx)
	}()

	t.Cleanup(func() {
		stopHub()
		<-hubDone
	})

	return idleHub{
		hub:           hub,
		authenticator: authenticator,
		token:         authtest.Sign(t, key, issuer.Claims("idle-user", time.Now())),
	}
}

func TestRealtimeWebSocketOutlivesTheWriteTimeout(t *testing.T) {
	const writeTimeout = 300 * time.Millisecond

	logger := slog.New(slog.DiscardHandler)
	idle := startIdleHub(t, logger)

	running := startServer(t, server.Options{
		WriteTimeout:  writeTimeout,
		Authenticator: idle.authenticator,
		Realtime:      idle.hub,
		Logger:        logger,
	})

	dialCtx, cancelDial := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancelDial()

	conn, response, err := websocket.Dial(dialCtx, "ws://"+running.apiAddress+realtime.Path, &websocket.DialOptions{
		Subprotocols: []string{realtime.Subprotocol, realtime.BearerSubprotocolPrefix + idle.token},
		HTTPHeader:   http.Header{"Origin": {"app://obsidian.md"}},
	})
	require.NoError(t, err)
	require.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)
	t.Cleanup(func() { _ = conn.CloseNow() })

	// Idle well past the API write timeout, which must not apply to the
	// long-lived WebSocket.
	time.Sleep(3 * writeTimeout)

	data, err := proto.Marshal(&vaultsyncv1.ClientFrame{RequestId: 1, Frame: &vaultsyncv1.ClientFrame_Subscribe{
		Subscribe: &vaultsyncv1.Subscribe{VaultId: uuid.NewString()},
	}})
	require.NoError(t, err)

	ioCtx, cancelIO := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancelIO()

	require.NoError(t, conn.Write(ioCtx, websocket.MessageBinary, data))

	_, reply, err := conn.Read(ioCtx)
	require.NoError(t, err, "the server must still write to an idle WebSocket after the write timeout")

	var frame vaultsyncv1.ServerFrame
	require.NoError(t, proto.Unmarshal(reply, &frame))
	assert.Equal(t, uint64(1), frame.GetRequestId())
	assert.NotNil(t, frame.GetSubscribed(), "expected subscribed, got %v", &frame)
}

// hijackRecorder is a response writer standing in for the HTTP server's
// connection, so that the write deadlines the API handler sets are
// observable. Hijack hands over one end of an in-memory pipe.
type hijackRecorder struct {
	header   http.Header
	conn     net.Conn
	hijacked chan struct{}

	mu sync.Mutex
	// deadlines are the non-zero write deadlines set after the hijack.
	deadlines []time.Time
	isHijack  bool
}

func newHijackRecorder(conn net.Conn) *hijackRecorder {
	return &hijackRecorder{header: http.Header{}, conn: conn, hijacked: make(chan struct{})}
}

func (recorder *hijackRecorder) Header() http.Header { return recorder.header }

func (recorder *hijackRecorder) Write(data []byte) (int, error) { return len(data), nil }

func (recorder *hijackRecorder) WriteHeader(int) {}

func (recorder *hijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	recorder.mu.Lock()
	recorder.isHijack = true
	recorder.mu.Unlock()
	close(recorder.hijacked)

	return recorder.conn, bufio.NewReadWriter(bufio.NewReader(recorder.conn), bufio.NewWriter(recorder.conn)), nil
}

func (recorder *hijackRecorder) SetReadDeadline(time.Time) error { return nil }

func (recorder *hijackRecorder) SetWriteDeadline(deadline time.Time) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	if recorder.isHijack && !deadline.IsZero() {
		recorder.deadlines = append(recorder.deadlines, deadline)
	}

	return nil
}

func (recorder *hijackRecorder) deadlinesAfterHijack() []time.Time {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	return slices.Clone(recorder.deadlines)
}

func TestHijackedConnectionsGetNoWriteDeadline(t *testing.T) {
	logger := slog.New(slog.DiscardHandler)
	idle := startIdleHub(t, logger)
	handler := server.New(testOptions(server.Options{
		Authenticator: idle.authenticator,
		Realtime:      idle.hub,
		Logger:        logger,
	})).Handler()

	serverEnd, clientEnd := net.Pipe()

	t.Cleanup(func() { _ = serverEnd.Close() })

	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, realtime.Path, nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	request.Header.Set("Sec-WebSocket-Protocol", realtime.Subprotocol+", "+realtime.BearerSubprotocolPrefix+idle.token)
	request.Header.Set("Origin", "app://obsidian.md")

	recorder := newHijackRecorder(serverEnd)
	served := make(chan struct{})

	go func() {
		defer close(served)

		handler.ServeHTTP(recorder, request)
	}()

	// The upgrade takes over the connection; the client then goes away,
	// which ends the WebSocket and its handler.
	select {
	case <-recorder.hijacked:
	case <-served:
		require.FailNow(t, "the upgrade must hijack the connection")
	}

	require.NoError(t, clientEnd.Close())
	<-served

	// A deadline set once the handler returns would apply to a connection
	// the HTTP server no longer owns: a hijacking handler that hands its
	// connection on and returns would see it cut off.
	assert.Empty(t, recorder.deadlinesAfterHijack(), "no write deadline may be set on a hijacked connection")
}
