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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// largeVaults is a vault store whose ListVaults returns one vault with a
// name of whatever length the test sets, so the response can be made as
// large as needed. Names that long are never stored for real; the store is
// a stand-in for any handler producing a large response.
type largeVaults struct {
	nameLength atomic.Int64
	// listed receives a value each time ListVaults is called, if not nil.
	listed chan struct{}
}

func (vaults *largeVaults) CreateVault(context.Context, uuid.UUID, store.NewVault, int) (store.Vault, error) {
	return store.Vault{}, errors.New("not supported")
}

func (vaults *largeVaults) ListVaults(context.Context, uuid.UUID, uuid.UUID, int) ([]store.Vault, error) {
	if vaults.listed != nil {
		vaults.listed <- struct{}{}
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

	clients := map[string]vaultsyncv1connect.VaultServiceClient{
		// The default client accepts gzip, and these responses compress
		// far below the limit: the limit applies to the message itself.
		"compressed":   client,
		"uncompressed": vaultsyncv1connect.NewVaultServiceClient(http.DefaultClient, fixture.running.apiURL(), connect.WithAcceptCompression("gzip", nil, nil)),
		"json":         vaultsyncv1connect.NewVaultServiceClient(http.DefaultClient, fixture.running.apiURL(), connect.WithProtoJSON()),
	}

	for clientName, client := range clients {
		for _, test := range tests {
			t.Run(clientName+"/"+test.name, func(t *testing.T) {
				vaults.nameLength.Store(int64(nameLengthForResponseSize(t, template.Msg, test.size)))

				response, err := client.ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{}, token))
				test.assertError(t, err)

				if err == nil {
					assert.Equal(t, test.size, proto.Size(response.Msg))
				}
			})
		}
	}
}

func TestServerReleasesConnectionsOfClientsThatDoNotRead(t *testing.T) {
	const (
		writeTimeout = 300 * time.Millisecond
		// Far more than the kernel buffers on both ends of the connection
		// hold, so the server blocks writing until the client reads.
		responseBytes = 24 << 20
	)

	vaults := &largeVaults{listed: make(chan struct{}, 1)}
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

	select {
	case <-vaults.listed:
	case <-time.After(10 * time.Second):
		t.Fatal("the request did not reach the handler")
	}

	// The write deadline was set before the handler ran, so it has passed
	// once the client has not read for writeTimeout since.
	time.Sleep(writeTimeout)

	// Reading now gets what the kernel buffered, then the closed connection
	// instead of the rest of the response. The read deadline only keeps a
	// broken server from hanging the test.
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(30*time.Second)))

	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
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

	if database.inFlight == 2 {
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
