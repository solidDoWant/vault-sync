package server_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// blockingVaults is a vault store whose first `blocked` ListVaults calls
// wait until release is closed (or their request ends); later calls return
// at once. entered receives one value per call that reached the handler.
type blockingVaults struct {
	mu      sync.Mutex
	blocked int
	calls   int
	entered chan struct{}
	release chan struct{}
}

func newBlockingVaults(blocked int) *blockingVaults {
	return &blockingVaults{blocked: blocked, entered: make(chan struct{}, 1024), release: make(chan struct{})}
}

func (vaults *blockingVaults) CreateVault(context.Context, uuid.UUID, store.NewVault, int) (store.Vault, error) {
	return store.Vault{}, errors.New("not supported")
}

func (vaults *blockingVaults) ListVaults(ctx context.Context, _, _ uuid.UUID, _ int) ([]store.Vault, error) {
	vaults.mu.Lock()
	vaults.calls++
	block := vaults.calls <= vaults.blocked
	vaults.mu.Unlock()

	vaults.entered <- struct{}{}

	if block {
		select {
		case <-vaults.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	return nil, nil
}

func (vaults *blockingVaults) callCount() int {
	vaults.mu.Lock()
	defer vaults.mu.Unlock()

	return vaults.calls
}

// waitEntered waits until count more calls reached the handler. The
// timeout only keeps a broken server from hanging the test.
func (vaults *blockingVaults) waitEntered(t *testing.T, count int) {
	t.Helper()

	timeout := time.NewTimer(30 * time.Second)
	defer timeout.Stop()

	for range count {
		select {
		case <-vaults.entered:
		case <-timeout.C:
			require.FailNow(t, "handler calls did not start")
		}
	}
}

type concurrencyFixture struct {
	issuer  *authtest.Issuer
	key     authtest.Key
	running *runningServer
	client  vaultsyncv1connect.VaultServiceClient
}

func newConcurrencyFixture(t *testing.T, vaults api.VaultStore, options server.Options) *concurrencyFixture {
	t.Helper()

	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.RS256)
	logger := slog.New(slog.DiscardHandler)

	options.Authenticator = auth.NewAuthenticator(auth.NewVerifier(auth.VerifierOptions{
		IssuerURL: issuer.URL,
		Audience:  authtest.DefaultAudience,
		Logger:    logger,
	}), newMemoryStore())
	options.Vaults = vaults
	options.Logger = logger

	running := startServer(t, options)

	// Every concurrent call needs its own HTTP/1.1 connection.
	httpClient := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64}}
	t.Cleanup(httpClient.CloseIdleConnections)

	return &concurrencyFixture{
		issuer:  issuer,
		key:     key,
		running: running,
		client:  vaultsyncv1connect.NewVaultServiceClient(httpClient, running.apiURL()),
	}
}

func (fixture *concurrencyFixture) token(t *testing.T, subject string) string {
	t.Helper()

	return authtest.Sign(t, fixture.key, fixture.issuer.Claims(subject, time.Now()))
}

// listVaults calls ListVaults, bounded so that a request that is queued
// rather than rejected fails the test instead of hanging it.
func (fixture *concurrencyFixture) listVaults(ctx context.Context, token string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	_, err := fixture.client.ListVaults(ctx, authorized(&vaultsyncv1.ListVaultsRequest{}, token))

	return err
}

// startBlockedCalls starts count ListVaults calls in the background and
// returns a channel yielding their results once they end.
func (fixture *concurrencyFixture) startBlockedCalls(t *testing.T, token string, count int) <-chan error {
	t.Helper()

	results := make(chan error, count)

	for range count {
		go func() { results <- fixture.listVaults(t.Context(), token) }()
	}

	return results
}

func requireResourceExhausted(t *testing.T, err error) {
	t.Helper()

	require.Error(t, err)
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err), "error: %v", err)
}

// metricValue returns the value of the unlabeled (or fully matched) sample
// line starting with name on /metrics, or "" when there is none.
func metricValue(t *testing.T, running *runningServer, name string) string {
	t.Helper()

	status, body := get(t, running.metricsURL()+"/metrics")
	require.Equal(t, http.StatusOK, status)

	for line := range strings.SplitSeq(body, "\n") {
		if value, found := strings.CutPrefix(line, name+" "); found {
			return value
		}
	}

	return ""
}

func TestConcurrentRPCsPerUserAreBounded(t *testing.T) {
	const limit = 3

	vaults := newBlockingVaults(limit)
	fixture := newConcurrencyFixture(t, vaults, server.Options{MaxConcurrentRPCsPerUser: limit})
	greedy := fixture.token(t, "greedy-user")
	other := fixture.token(t, "other-user")

	// Exactly the limit is admitted: every call reaches the handler and
	// stays there.
	results := fixture.startBlockedCalls(t, greedy, limit)
	vaults.waitEntered(t, limit)

	// One more is rejected at once, without reaching the handler (whose
	// later calls would succeed) and without waiting for a slot.
	requireResourceExhausted(t, fixture.listVaults(t.Context(), greedy))
	assert.Equal(t, limit, vaults.callCount(), "a rejected call must not reach the handler")

	// Another user is unaffected.
	require.NoError(t, fixture.listVaults(t.Context(), other), "another user must not be limited by the first")

	assert.Equal(t, "1", metricValue(t, fixture.running,
		`vault_sync_rpc_concurrency_rejections_total{procedure="/vaultsync.v1.VaultService/ListVaults"}`))

	close(vaults.release)

	for range limit {
		require.NoError(t, <-results)
	}

	// The slots are free again.
	require.NoError(t, fixture.listVaults(t.Context(), greedy))
}

func TestConcurrentRPCLimitDefaultsToTheConfigurationDefault(t *testing.T) {
	vaults := newBlockingVaults(config.DefaultMaxConcurrentRPCsPerUser)
	fixture := newConcurrencyFixture(t, vaults, server.Options{})
	token := fixture.token(t, "greedy-user")

	results := fixture.startBlockedCalls(t, token, config.DefaultMaxConcurrentRPCsPerUser)
	vaults.waitEntered(t, config.DefaultMaxConcurrentRPCsPerUser)

	requireResourceExhausted(t, fixture.listVaults(t.Context(), token))

	close(vaults.release)

	for range config.DefaultMaxConcurrentRPCsPerUser {
		require.NoError(t, <-results)
	}
}

func TestConcurrentRPCLimitDoesNotApplyToPublicProcedures(t *testing.T) {
	vaults := newBlockingVaults(1)
	fixture := newConcurrencyFixture(t, vaults, server.Options{MaxConcurrentRPCsPerUser: 1})
	token := fixture.token(t, "greedy-user")

	results := fixture.startBlockedCalls(t, token, 1)
	vaults.waitEntered(t, 1)

	info := vaultsyncv1connect.NewServerInfoServiceClient(http.DefaultClient, fixture.running.apiURL())
	_, err := info.GetServerInfo(t.Context(), authorized(&vaultsyncv1.GetServerInfoRequest{}, token))
	require.NoError(t, err)

	close(vaults.release)
	require.NoError(t, <-results)
}

func TestConcurrentRPCLimiterForgetsIdleUsers(t *testing.T) {
	const users = 5

	vaults := newBlockingVaults(users)
	fixture := newConcurrencyFixture(t, vaults, server.Options{MaxConcurrentRPCsPerUser: 1})

	results := make([]<-chan error, 0, users)
	for index := range users {
		results = append(results, fixture.startBlockedCalls(t, fixture.token(t, fmt.Sprintf("user-%d", index)), 1))
	}

	vaults.waitEntered(t, users)

	assert.Equal(t, fmt.Sprint(users), metricValue(t, fixture.running, "vault_sync_rpc_in_flight"))
	assert.Equal(t, fmt.Sprint(users), metricValue(t, fixture.running, "vault_sync_rpc_in_flight_users"))

	close(vaults.release)

	for _, result := range results {
		require.NoError(t, <-result)
	}

	// A slot is released once the response is written, which the client
	// may observe slightly before the server finishes.
	require.Eventually(t, func() bool {
		return metricValue(t, fixture.running, "vault_sync_rpc_in_flight") == "0" &&
			metricValue(t, fixture.running, "vault_sync_rpc_in_flight_users") == "0"
	}, 30*time.Second, 10*time.Millisecond, "idle users must not stay tracked")
}

// startUnreadResponse sends a ListVaults request on a raw connection and
// waits for the response to start, then never reads the rest.
func startUnreadResponse(t *testing.T, address, token string) net.Conn {
	t.Helper()

	conn, err := net.Dial("tcp", address)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	_, err = fmt.Fprintf(conn, "POST /vaultsync.v1.VaultService/ListVaults HTTP/1.1\r\nHost: vault-sync\r\n"+
		"Authorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}", token)
	require.NoError(t, err)

	require.NoError(t, conn.SetReadDeadline(time.Now().Add(30*time.Second)))

	_, err = bufio.NewReader(conn).Peek(1)
	require.NoError(t, err, "the server must start the response")

	return conn
}

func TestConcurrentRPCSlotIsHeldUntilTheResponseIsWritten(t *testing.T) {
	// Far more than the kernel buffers on both ends of the connection
	// hold, so the server blocks writing until the client reads.
	const responseBytes = 24 << 20

	vaults := &largeVaults{}
	vaults.nameLength.Store(responseBytes)

	fixture := newConcurrencyFixture(t, vaults, server.Options{
		MaxConcurrentRPCsPerUser: 1,
		MaxRequestBytes:          32 << 20,
		// Long enough that the stalled write cannot time out during the
		// test.
		WriteTimeout: time.Hour,
	})
	token := fixture.token(t, "stalled-user")

	conn := startUnreadResponse(t, fixture.running.apiAddress, token)

	// The handler has returned, but its response is still being written to
	// a client that does not read: the slot is still held.
	requireResourceExhausted(t, fixture.listVaults(t.Context(), token))

	// Once the connection ends, the write fails and the slot is released.
	require.NoError(t, conn.Close())

	vaults.nameLength.Store(16)
	require.Eventually(t, func() bool {
		return fixture.listVaults(t.Context(), token) == nil
	}, 30*time.Second, 10*time.Millisecond, "the slot must be released once the response ends")
}

func TestConcurrentRPCSlotIsReleasedByTheWriteTimeout(t *testing.T) {
	const responseBytes = 24 << 20

	vaults := &largeVaults{}
	vaults.nameLength.Store(responseBytes)

	fixture := newConcurrencyFixture(t, vaults, server.Options{
		MaxConcurrentRPCsPerUser: 1,
		MaxRequestBytes:          32 << 20,
		WriteTimeout:             300 * time.Millisecond,
	})
	token := fixture.token(t, "stalled-user")

	// The client keeps the connection open but never reads; only the write
	// timeout can end the response.
	startUnreadResponse(t, fixture.running.apiAddress, token)

	vaults.nameLength.Store(16)
	require.Eventually(t, func() bool {
		return fixture.listVaults(t.Context(), token) == nil
	}, 30*time.Second, 10*time.Millisecond, "the write timeout must release the slot of a client that stopped reading")
}
