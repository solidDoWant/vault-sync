package realtime_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// readTimeout bounds waiting for one expected frame. It is generous: tests
// never wait for it to pass.
const readTimeout = 10 * time.Second

const allowedOrigin = "app://obsidian.md"

// userNamespace derives user ids from subjects, so tests know them.
var userNamespace = uuid.MustParse("6f1d3c9e-8a51-4c7b-9a43-1c2b3d4e5f60")

func userID(subject string) uuid.UUID {
	return uuid.NewSHA1(userNamespace, []byte(subject))
}

type users struct{}

func (users) UpsertUser(_ context.Context, _, subject string) (uuid.UUID, error) {
	return userID(subject), nil
}

// fakeStore is an in-memory membership and commit store. Commits are
// announced to the hub through ListenVaultChanges, like PostgreSQL's
// LISTEN/NOTIFY.
type fakeStore struct {
	mu      sync.Mutex
	members map[uuid.UUID]map[uuid.UUID]store.Role
	heads   map[uuid.UUID]int64

	changes chan store.VaultChange
	// failListen ends the current ListenVaultChanges with an error.
	failListen chan struct{}
	// ready receives a value each time a listener is subscribed.
	ready chan struct{}

	// When gate is set, MemberHeadSeq announces itself on entered and
	// then waits for gate, simulating a slow membership query.
	entered chan struct{}
	gate    chan struct{}

	// membershipErrors makes the membership check before delivery (but
	// not MemberHeadSeq) fail for a vault, simulating a database error at
	// delivery time.
	membershipErrors map[uuid.UUID]error
	// membershipQueries counts the membership checks made before
	// delivery, each one a database round trip.
	membershipQueries int
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		members:          map[uuid.UUID]map[uuid.UUID]store.Role{},
		heads:            map[uuid.UUID]int64{},
		changes:          make(chan store.VaultChange),
		failListen:       make(chan struct{}),
		ready:            make(chan struct{}, 16),
		membershipErrors: map[uuid.UUID]error{},
	}
}

func (fake *fakeStore) createVault(owner string) uuid.UUID {
	fake.mu.Lock()
	defer fake.mu.Unlock()

	vaultID := uuid.New()
	fake.heads[vaultID] = 0
	fake.members[vaultID] = map[uuid.UUID]store.Role{userID(owner): store.RoleOwner}

	return vaultID
}

func (fake *fakeStore) setMember(vaultID uuid.UUID, subject string, role store.Role) {
	fake.mu.Lock()
	defer fake.mu.Unlock()

	if role == "" {
		delete(fake.members[vaultID], userID(subject))

		return
	}

	fake.members[vaultID][userID(subject)] = role
}

// commit advances the vault's head without announcing it.
func (fake *fakeStore) advance(vaultID uuid.UUID) int64 {
	fake.mu.Lock()
	defer fake.mu.Unlock()

	fake.heads[vaultID]++

	return fake.heads[vaultID]
}

// commit advances the vault's head and announces it to the listener.
func (fake *fakeStore) commit(t *testing.T, vaultID uuid.UUID) int64 {
	t.Helper()

	seq := fake.advance(vaultID)

	select {
	case fake.changes <- store.VaultChange{VaultID: vaultID, Seq: seq}:
	case <-time.After(readTimeout):
		t.Fatal("the hub is not listening for commits")
	}

	return seq
}

// failMembershipLookup makes the membership check before delivery fail for
// vaultID with err; nil clears it.
func (fake *fakeStore) failMembershipLookup(vaultID uuid.UUID, err error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()

	fake.membershipErrors[vaultID] = err
}

// queries returns the number of membership checks made before delivery.
func (fake *fakeStore) queries() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()

	return fake.membershipQueries
}

func (fake *fakeStore) VaultMembers(_ context.Context, vaultID uuid.UUID, users []uuid.UUID) (map[uuid.UUID]bool, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()

	fake.membershipQueries++

	if err := fake.membershipErrors[vaultID]; err != nil {
		return nil, err
	}

	members := map[uuid.UUID]bool{}

	for _, user := range users {
		if _, ok := fake.members[vaultID][user]; ok {
			members[user] = true
		}
	}

	return members, nil
}

func (fake *fakeStore) role(vaultID, user uuid.UUID) (store.Role, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()

	role, ok := fake.members[vaultID][user]
	if !ok {
		return "", store.ErrVaultNotFound
	}

	return role, nil
}

func (fake *fakeStore) MemberHeadSeq(_ context.Context, vaultID, user uuid.UUID) (store.Role, int64, error) {
	if fake.gate != nil {
		fake.entered <- struct{}{}

		<-fake.gate
	}

	role, err := fake.role(vaultID, user)
	if err != nil {
		return "", 0, err
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()

	return role, fake.heads[vaultID], nil
}

func (fake *fakeStore) HeadSeqs(_ context.Context, vaultIDs []uuid.UUID) (map[uuid.UUID]int64, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()

	heads := map[uuid.UUID]int64{}

	for _, vaultID := range vaultIDs {
		if head, ok := fake.heads[vaultID]; ok {
			heads[vaultID] = head
		}
	}

	return heads, nil
}

func (fake *fakeStore) ListenVaultChanges(ctx context.Context, options store.ListenOptions) error {
	options.Ready(ctx)

	fake.ready <- struct{}{}

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-fake.failListen:
			return errors.New("connection lost")
		case change := <-fake.changes:
			options.Handle(change)
		}
	}
}

// fixture is a hub served over HTTP with a fake issuer and store.
type fixture struct {
	hub      *realtime.Hub
	store    *fakeStore
	issuer   *authtest.Issuer
	key      authtest.Key
	server   *httptest.Server
	registry *prometheus.Registry
}

type fixtureOptions struct {
	limits realtime.Limits
	// verifierNow is the verifier's clock; defaults to time.Now.
	verifierNow func() time.Time
	// listener serves the hub instead of a TCP listener.
	listener net.Listener
}

func newFixture(t *testing.T, options fixtureOptions) *fixture {
	t.Helper()

	issuer := authtest.NewIssuer(t)
	fake := newFakeStore()
	verifier := auth.NewVerifier(auth.VerifierOptions{
		IssuerURL: issuer.URL,
		Audience:  authtest.DefaultAudience,
		Now:       options.verifierNow,
	})

	hub := realtime.NewHub(realtime.Options{
		Authenticator:  auth.NewAuthenticator(verifier, users{}),
		Store:          fake,
		AllowedOrigins: []string{allowedOrigin},
		Limits:         options.limits,
	})

	registry := prometheus.NewRegistry()
	registry.MustRegister(hub.Collectors()...)

	ctx, cancel := context.WithCancel(context.WithoutCancel(t.Context()))
	done := make(chan struct{})

	go func() {
		defer close(done)

		hub.Run(ctx)
	}()

	server := httptest.NewUnstartedServer(hub)
	if options.listener != nil {
		_ = server.Listener.Close()
		server.Listener = options.listener
	}

	server.Start()

	t.Cleanup(func() {
		drainCtx, cancelDrain := context.WithTimeout(context.WithoutCancel(t.Context()), readTimeout)
		defer cancelDrain()

		_ = hub.Drain(drainCtx)

		cancel()
		<-done
		server.Close()
	})

	select {
	case <-fake.ready:
	case <-time.After(readTimeout):
		t.Fatal("the hub did not start listening")
	}

	return &fixture{hub: hub, store: fake, issuer: issuer, key: issuer.AddKey(t, jose.RS256), server: server, registry: registry}
}

func (fixture *fixture) url() string {
	return "ws" + strings.TrimPrefix(fixture.server.URL, "http") + realtime.Path
}

func (fixture *fixture) token(t *testing.T, subject string) string {
	t.Helper()

	return authtest.Sign(t, fixture.key, fixture.issuer.Claims(subject, time.Now()))
}

func (fixture *fixture) metric(t *testing.T, name, reason string) float64 {
	t.Helper()

	families, err := fixture.registry.Gather()
	require.NoError(t, err)

	for _, family := range families {
		if family.GetName() != name {
			continue
		}

		for _, metric := range family.GetMetric() {
			for _, label := range metric.GetLabel() {
				if label.GetName() == "reason" && label.GetValue() == reason {
					return metric.GetCounter().GetValue()
				}
			}
		}
	}

	return 0
}

// client is one test WebSocket client.
type client struct {
	t    *testing.T
	conn *websocket.Conn
}

func bearerProtocols(token string) []string {
	return []string{realtime.Subprotocol, realtime.BearerSubprotocolPrefix + token}
}

func (fixture *fixture) dial(t *testing.T, options *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
	t.Helper()

	ctx, cancel := context.WithTimeout(t.Context(), readTimeout)
	defer cancel()

	conn, response, err := websocket.Dial(ctx, fixture.url(), options)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}

	if conn != nil {
		t.Cleanup(func() { _ = conn.CloseNow() })
	}

	return conn, response, err
}

func (fixture *fixture) connect(t *testing.T, subject string) *client {
	t.Helper()

	conn, response, err := fixture.dial(t, &websocket.DialOptions{Subprotocols: bearerProtocols(fixture.token(t, subject))})
	require.NoError(t, err)
	require.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)

	return &client{t: t, conn: conn}
}

func (client *client) send(frame *vaultsyncv1.ClientFrame) {
	client.t.Helper()

	data, err := proto.Marshal(frame)
	require.NoError(client.t, err)

	ctx, cancel := context.WithTimeout(client.t.Context(), readTimeout)
	defer cancel()

	require.NoError(client.t, client.conn.Write(ctx, websocket.MessageBinary, data))
}

func (client *client) read() *vaultsyncv1.ServerFrame {
	client.t.Helper()

	frame, err := client.tryRead()
	require.NoError(client.t, err)

	return frame
}

func (client *client) tryRead() (*vaultsyncv1.ServerFrame, error) {
	ctx, cancel := context.WithTimeout(client.t.Context(), readTimeout)
	defer cancel()

	messageType, data, err := client.conn.Read(ctx)
	if err != nil {
		return nil, err
	}

	if messageType != websocket.MessageBinary {
		return nil, errors.New("text frame from server")
	}

	var frame vaultsyncv1.ServerFrame
	if err := proto.Unmarshal(data, &frame); err != nil {
		return nil, err
	}

	return &frame, nil
}

// closeStatus reads until the connection ends and returns its close status.
func (client *client) closeStatus() websocket.StatusCode {
	client.t.Helper()

	for {
		_, err := client.tryRead()
		if err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func subscribeFrame(requestID uint64, vaultID uuid.UUID) *vaultsyncv1.ClientFrame {
	return &vaultsyncv1.ClientFrame{RequestId: requestID, Frame: &vaultsyncv1.ClientFrame_Subscribe{
		Subscribe: &vaultsyncv1.Subscribe{VaultId: vaultID.String()},
	}}
}

func unsubscribeFrame(vaultID uuid.UUID) *vaultsyncv1.ClientFrame {
	return &vaultsyncv1.ClientFrame{Frame: &vaultsyncv1.ClientFrame_Unsubscribe{
		Unsubscribe: &vaultsyncv1.Unsubscribe{VaultId: vaultID.String()},
	}}
}

// subscribe subscribes and requires success, returning the head_seq.
func (client *client) subscribe(requestID uint64, vaultID uuid.UUID) uint64 {
	client.t.Helper()

	client.send(subscribeFrame(requestID, vaultID))

	frame := client.read()
	require.Equal(client.t, requestID, frame.GetRequestId())
	require.NotNil(client.t, frame.GetSubscribed(), "expected subscribed, got %v", frame)
	require.Equal(client.t, vaultID.String(), frame.GetSubscribed().GetVaultId())

	return frame.GetSubscribed().GetHeadSeq()
}

func (client *client) expectVaultChanged(vaultID uuid.UUID, seq int64) {
	client.t.Helper()

	frame := client.read()
	require.NotNil(client.t, frame.GetVaultChanged(), "expected vault_changed, got %v", frame)
	assert.Equal(client.t, vaultID.String(), frame.GetVaultChanged().GetVaultId())
	assert.Equal(client.t, uint64(seq), frame.GetVaultChanged().GetSeq()) //nolint:gosec // test seqs are small.
	assert.Zero(client.t, frame.GetRequestId())
}

func TestSubscriberReceivesVaultChangedAfterAnotherClientCommits(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	vaultID := fixture.store.createVault("alice")
	fixture.store.setMember(vaultID, "bob", store.RoleViewer)

	alice := fixture.connect(t, "alice")
	bob := fixture.connect(t, "bob")

	assert.Equal(t, uint64(0), alice.subscribe(1, vaultID))
	assert.Equal(t, uint64(0), bob.subscribe(7, vaultID))

	seq := fixture.store.commit(t, vaultID)

	alice.expectVaultChanged(vaultID, seq)
	bob.expectVaultChanged(vaultID, seq)

	// The head_seq at subscribe time lets a late subscriber catch up.
	carol := fixture.connect(t, "alice")
	assert.Equal(t, uint64(seq), carol.subscribe(2, vaultID)) //nolint:gosec // test seqs are small.
}

func TestOneConnectionMultiplexesSeveralVaults(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	first := fixture.store.createVault("alice")
	second := fixture.store.createVault("alice")

	alice := fixture.connect(t, "alice")
	alice.subscribe(1, first)
	alice.subscribe(2, second)

	alice.expectVaultChangedAfter(fixture, second)
	alice.expectVaultChangedAfter(fixture, first)

	// After unsubscribing, the vault's commits are no longer delivered;
	// the next frame is the other vault's.
	alice.send(unsubscribeFrame(first))
	alice.subscribe(3, second)

	fixture.store.commit(t, first)
	alice.expectVaultChangedAfter(fixture, second)
}

// expectVaultChangedAfter commits to vaultID and expects its notification.
func (client *client) expectVaultChangedAfter(fixture *fixture, vaultID uuid.UUID) {
	client.t.Helper()

	client.expectVaultChanged(vaultID, fixture.store.commit(client.t, vaultID))
}

func TestUpgradeIsRefusedWithoutAValidTokenOrFromADisallowedOrigin(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})

	expiredClaims := fixture.issuer.Claims("alice", time.Now().Add(-2*time.Hour))
	otherIssuer := authtest.NewIssuer(t)
	otherKey := otherIssuer.AddKey(t, jose.RS256)
	valid := fixture.token(t, "alice")

	tests := []struct {
		name       string
		protocols  []string
		header     http.Header
		wantStatus int
	}{
		{name: "no token", protocols: []string{realtime.Subprotocol}, wantStatus: http.StatusUnauthorized},
		{name: "garbage token", protocols: bearerProtocols("not-a-jwt"), wantStatus: http.StatusUnauthorized},
		{name: "empty token", protocols: bearerProtocols(""), wantStatus: http.StatusUnauthorized},
		{name: "expired token", protocols: bearerProtocols(authtest.Sign(t, fixture.key, expiredClaims)), wantStatus: http.StatusUnauthorized},
		{
			name:       "token from another issuer",
			protocols:  bearerProtocols(authtest.Sign(t, otherKey, otherIssuer.Claims("alice", time.Now()))),
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "two bearer subprotocols",
			protocols:  append(bearerProtocols(valid), realtime.BearerSubprotocolPrefix+valid+"x"),
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "subprotocol and Authorization header",
			protocols:  bearerProtocols(valid),
			header:     http.Header{"Authorization": {"Bearer " + valid}},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "non-bearer Authorization header",
			protocols:  []string{realtime.Subprotocol},
			header:     http.Header{"Authorization": {"Basic " + valid}},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "disallowed origin",
			protocols:  bearerProtocols(valid),
			header:     http.Header{"Origin": {"https://evil.example"}},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "two origins",
			protocols:  bearerProtocols(valid),
			header:     http.Header{"Origin": {allowedOrigin, "https://evil.example"}},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "disallowed origin without a token",
			protocols:  []string{realtime.Subprotocol},
			header:     http.Header{"Origin": {"https://evil.example"}},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "missing vaultsync.v1 subprotocol",
			protocols:  []string{realtime.BearerSubprotocolPrefix + valid},
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			conn, response, err := fixture.dial(t, &websocket.DialOptions{Subprotocols: test.protocols, HTTPHeader: test.header})
			require.Error(t, err)
			assert.Nil(t, conn)
			require.NotNil(t, response)
			assert.Equal(t, test.wantStatus, response.StatusCode)
		})
	}

	assert.Equal(t, 8.0, fixture.metric(t, "vault_sync_realtime_refused_upgrades_total", "unauthenticated"))
}

func TestUpgradeAcceptsTheTokenFromEitherTransportAndEchoesOnlyTheProtocol(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	vaultID := fixture.store.createVault("alice")
	token := fixture.token(t, "alice")

	tests := []struct {
		name    string
		options *websocket.DialOptions
	}{
		{
			name: "bearer subprotocol from an allowed origin",
			options: &websocket.DialOptions{
				Subprotocols: bearerProtocols(token),
				HTTPHeader:   http.Header{"Origin": {allowedOrigin}},
			},
		},
		{
			name: "Authorization header without an origin",
			options: &websocket.DialOptions{
				Subprotocols: []string{realtime.Subprotocol},
				HTTPHeader:   http.Header{"Authorization": {"Bearer " + token}},
			},
		},
	}

	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			conn, response, err := fixture.dial(t, test.options)
			require.NoError(t, err)
			assert.Equal(t, []string{realtime.Subprotocol}, response.Header.Values("Sec-WebSocket-Protocol"))
			assert.Equal(t, realtime.Subprotocol, conn.Subprotocol())

			client := &client{t: t, conn: conn}
			client.subscribe(uint64(index+1), vaultID) //nolint:gosec // small index.
		})
	}
}

func TestNonMemberSubscriptionIsRefusedAndNeverNotified(t *testing.T) {
	// With one subscription allowed, a refused subscription must not
	// hold the slot.
	fixture := newFixture(t, fixtureOptions{limits: realtime.Limits{MaxSubscriptions: 1}})
	aliceVault := fixture.store.createVault("alice")
	malloryVault := fixture.store.createVault("mallory")
	missingVault := uuid.New()

	mallory := fixture.connect(t, "mallory")

	mallory.send(subscribeFrame(1, aliceVault))
	notMember := mallory.read()

	mallory.send(subscribeFrame(2, missingVault))
	missing := mallory.read()

	for _, frame := range []*vaultsyncv1.ServerFrame{notMember, missing} {
		require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
		assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND, frame.GetError().GetCode())
		assert.False(t, frame.GetError().GetFatal())
	}

	// A non-member cannot tell an existing vault from a missing one.
	assert.Equal(t, notMember.GetError().GetMessage(), missing.GetError().GetMessage())
	assert.Equal(t, aliceVault.String(), notMember.GetError().GetVaultId())
	assert.Equal(t, missingVault.String(), missing.GetError().GetVaultId())
	assert.Equal(t, uint64(1), notMember.GetRequestId())

	// Commits to the refused vault are never delivered. Two commits to
	// mallory's own vault follow; the second is delivered after
	// everything queued with the first, so any notification for alice's
	// vault would be read before it.
	mallory.subscribe(3, malloryVault)
	fixture.store.commit(t, aliceVault)
	first := fixture.store.commit(t, malloryVault)
	fixture.store.commit(t, aliceVault)
	second := fixture.store.commit(t, malloryVault)

	for {
		frame := mallory.read()
		require.NotNil(t, frame.GetVaultChanged(), "unexpected frame %v", frame)
		require.Equal(t, malloryVault.String(), frame.GetVaultChanged().GetVaultId())

		if frame.GetVaultChanged().GetSeq() == uint64(second) { //nolint:gosec // test seqs are small.
			break
		}

		require.Equal(t, uint64(first), frame.GetVaultChanged().GetSeq()) //nolint:gosec // test seqs are small.
	}
}

func TestCommitDuringSubscribeIsReportedInTheSubscribedFrame(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	vaultID := fixture.store.createVault("alice")
	other := fixture.store.createVault("alice")
	alice := fixture.connect(t, "alice")
	alice.subscribe(1, other)

	fixture.store.entered = make(chan struct{})
	fixture.store.gate = make(chan struct{})

	alice.send(subscribeFrame(2, vaultID))
	<-fixture.store.entered

	// A commit while the subscription is being authorized is not
	// delivered ahead of the subscribed answer. Two commits to the other
	// vault follow; once the second is received, the first commit's
	// delivery has run.
	seq := fixture.store.commit(t, vaultID)
	alice.expectVaultChangedAfter(fixture, other)
	alice.expectVaultChangedAfter(fixture, other)

	close(fixture.store.gate)

	frame := alice.read()
	require.NotNil(t, frame.GetSubscribed(), "expected subscribed, got %v", frame)
	assert.Equal(t, uint64(seq), frame.GetSubscribed().GetHeadSeq()) //nolint:gosec // test seqs are small.

	alice.expectVaultChangedAfter(fixture, vaultID)
}

func TestSubscribeRejectsAnInvalidVaultID(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	alice := fixture.connect(t, "alice")

	alice.send(&vaultsyncv1.ClientFrame{RequestId: 4, Frame: &vaultsyncv1.ClientFrame_Subscribe{
		Subscribe: &vaultsyncv1.Subscribe{VaultId: "not-a-uuid"},
	}})

	frame := alice.read()
	require.NotNil(t, frame.GetError())
	assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, frame.GetError().GetCode())
	assert.Equal(t, uint64(4), frame.GetRequestId())
}

func TestRemovedMemberStopsReceivingNotifications(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	vaultID := fixture.store.createVault("alice")
	otherVault := fixture.store.createVault("bob")
	fixture.store.setMember(vaultID, "bob", store.RoleEditor)

	bob := fixture.connect(t, "bob")
	bob.subscribe(1, vaultID)
	bob.subscribe(2, otherVault)
	bob.expectVaultChangedAfter(fixture, vaultID)

	fixture.store.setMember(vaultID, "bob", "")
	fixture.store.commit(t, vaultID)

	// The subscription ends with an unsolicited NOT_FOUND naming the vault.
	frame := bob.read()
	require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
	assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND, frame.GetError().GetCode())
	assert.Equal(t, vaultID.String(), frame.GetError().GetVaultId())
	assert.False(t, frame.GetError().GetFatal())
	assert.Zero(t, frame.GetRequestId())

	// Later commits are not delivered, even after re-adding bob, until he
	// subscribes again; the next frame is the other vault's.
	fixture.store.commit(t, vaultID)
	fixture.store.setMember(vaultID, "bob", store.RoleViewer)
	fixture.store.commit(t, vaultID)
	bob.expectVaultChangedAfter(fixture, otherVault)
}

func TestFailedMembershipLookupDeliversNothing(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	vaultID := fixture.store.createVault("alice")
	otherVault := fixture.store.createVault("alice")

	alice := fixture.connect(t, "alice")
	alice.subscribe(1, vaultID)
	alice.subscribe(2, otherVault)

	// The membership check before delivery fails with a database error,
	// not ErrVaultNotFound: the notification must not be sent.
	fixture.store.failMembershipLookup(vaultID, errors.New("connection reset"))
	fixture.store.commit(t, vaultID)

	// Deliveries run one batch at a time, in order. The first commit to
	// the other vault is delivered in the failed commit's batch or a
	// later one; the second, committed after the first was received, in
	// a later batch still. So once the second is read, the failed
	// commit's delivery is over, and anything it queued would have been
	// read first.
	alice.expectVaultChangedAfter(fixture, otherVault)
	alice.expectVaultChangedAfter(fixture, otherVault)
	assert.Equal(t, 2.0, testutil.ToFloat64(collector(t, fixture, "vault_sync_realtime_notifications_total")))

	// The failure ends no subscription: once lookups succeed again, the
	// vault's commits are delivered.
	fixture.store.failMembershipLookup(vaultID, nil)
	alice.expectVaultChangedAfter(fixture, vaultID)
}

func TestDeliveryChecksMembershipInOneQueryPerBatchOfUsers(t *testing.T) {
	restore := realtime.SetMembershipBatch(2)
	t.Cleanup(restore)

	for _, test := range []struct {
		name     string
		subjects []string
		queries  int
	}{
		{name: "one user", subjects: []string{"alice"}, queries: 1},
		{name: "a full batch", subjects: []string{"alice", "bob"}, queries: 1},
		{name: "one user more than a batch", subjects: []string{"alice", "bob", "carol"}, queries: 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newFixture(t, fixtureOptions{})
			vaultID := fixture.store.createVault("alice")

			var clients []*client

			for _, subject := range test.subjects {
				fixture.store.setMember(vaultID, subject, store.RoleEditor)

				// Two devices per user: still one membership check
				// per user.
				for device := range 2 {
					conn := fixture.connect(t, subject)
					conn.subscribe(uint64(device+1), vaultID) //nolint:gosec // small test values.
					clients = append(clients, conn)
				}
			}

			before := fixture.store.queries()
			seq := fixture.store.commit(t, vaultID)

			for _, conn := range clients {
				conn.expectVaultChanged(vaultID, seq)
			}

			assert.Equal(t, test.queries, fixture.store.queries()-before)
		})
	}
}

func TestDisconnectReleasesTheConnectionsSubscriptions(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	vaultID := fixture.store.createVault("alice")
	fixture.store.setMember(vaultID, "bob", store.RoleViewer)

	alice := fixture.connect(t, "alice")
	alice.subscribe(1, vaultID)

	bob := fixture.connect(t, "bob")
	bob.subscribe(1, vaultID)

	connections := collector(t, fixture, "vault_sync_realtime_connections")
	notifications := collector(t, fixture, "vault_sync_realtime_notifications_total")

	require.NoError(t, alice.conn.Close(websocket.StatusNormalClosure, ""))
	require.Eventually(t, func() bool { return testutil.ToFloat64(connections) == 1 }, readTimeout, 10*time.Millisecond)

	// Two commits, the second made after bob received the first, so the
	// first's delivery is over when bob reads the second. Only bob is
	// still subscribed: one notification per commit. A subscription
	// left behind by alice's connection would be notified too.
	bob.expectVaultChangedAfter(fixture, vaultID)
	bob.expectVaultChangedAfter(fixture, vaultID)
	assert.Equal(t, 2.0, testutil.ToFloat64(notifications))
}

func TestSubscriptionsPerConnectionAreCapped(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{limits: realtime.Limits{MaxSubscriptions: 2}})
	vaults := []uuid.UUID{fixture.store.createVault("alice"), fixture.store.createVault("alice"), fixture.store.createVault("alice")}

	alice := fixture.connect(t, "alice")
	alice.subscribe(1, vaults[0])
	alice.subscribe(2, vaults[1])

	// Re-subscribing to a subscribed vault does not count again.
	alice.subscribe(3, vaults[1])

	alice.send(subscribeFrame(4, vaults[2]))

	frame := alice.read()
	require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
	assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_RESOURCE_EXHAUSTED, frame.GetError().GetCode())
	assert.False(t, frame.GetError().GetFatal())
	assert.Equal(t, uint64(4), frame.GetRequestId())

	// Unsubscribing frees a slot.
	alice.send(unsubscribeFrame(vaults[0]))
	alice.subscribe(5, vaults[2])
}

func TestConnectionsPerUserAndPerInstanceAreCapped(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{limits: realtime.Limits{MaxConnections: 3, MaxConnectionsPerUser: 2}})

	first := fixture.connect(t, "alice")
	fixture.connect(t, "alice")

	_, response, err := fixture.dial(t, &websocket.DialOptions{Subprotocols: bearerProtocols(fixture.token(t, "alice"))})
	require.Error(t, err)
	assert.Equal(t, http.StatusTooManyRequests, response.StatusCode)

	fixture.connect(t, "bob")

	_, response, err = fixture.dial(t, &websocket.DialOptions{Subprotocols: bearerProtocols(fixture.token(t, "carol"))})
	require.Error(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, response.StatusCode)

	// Closing a connection frees its slot.
	require.NoError(t, first.conn.Close(websocket.StatusNormalClosure, ""))
	require.Eventually(t, func() bool {
		conn, _, err := fixture.dial(t, &websocket.DialOptions{Subprotocols: bearerProtocols(fixture.token(t, "alice"))})
		if conn != nil {
			_ = conn.CloseNow()
		}

		return err == nil
	}, readTimeout, 10*time.Millisecond)
}

func TestOversizedFrameClosesTheConnection(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{limits: realtime.Limits{MaxFrameBytes: 64}})
	vaultID := fixture.store.createVault("alice")

	alice := fixture.connect(t, "alice")

	// A frame of exactly the limit is read. It is padded to the limit
	// with an unknown length-delimited field 15: tag byte, length, bytes.
	data, err := proto.Marshal(subscribeFrame(1, vaultID))
	require.NoError(t, err)

	padding := 64 - len(data) - 2
	require.Positive(t, padding)

	exact := append(data, 15<<3|2, byte(padding))
	exact = append(exact, make([]byte, padding)...)
	require.Len(t, exact, 64)

	ctx, cancel := context.WithTimeout(t.Context(), readTimeout)
	defer cancel()

	require.NoError(t, alice.conn.Write(ctx, websocket.MessageBinary, exact))
	frame := alice.read()
	require.NotNil(t, frame.GetSubscribed(), "expected subscribed, got %v", frame)

	// One byte more closes the connection with 1009.
	require.NoError(t, alice.conn.Write(ctx, websocket.MessageBinary, append(exact, 0)))
	assert.Equal(t, websocket.StatusMessageTooBig, alice.closeStatus())
}

func TestInboundFrameRateIsCapped(t *testing.T) {
	// A near-zero sustained rate leaves exactly the burst:
	// MaxSubscriptions + 32 frames.
	fixture := newFixture(t, fixtureOptions{limits: realtime.Limits{MaxSubscriptions: 1, FramesPerSecond: 1e-9}})
	vaultID := fixture.store.createVault("alice")

	alice := fixture.connect(t, "alice")

	for range 33 {
		alice.send(unsubscribeFrame(vaultID))
	}

	// The burst is spent but the connection is open.
	alice.send(subscribeFrame(1, vaultID))

	frame := alice.read()
	require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
	assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_RESOURCE_EXHAUSTED, frame.GetError().GetCode())
	assert.True(t, frame.GetError().GetFatal())
	assert.Equal(t, websocket.StatusPolicyViolation, alice.closeStatus())
}

func TestInboundFrameRateAllowsTheBurst(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{limits: realtime.Limits{MaxSubscriptions: 1, FramesPerSecond: 1e-9}})
	vaultID := fixture.store.createVault("alice")

	alice := fixture.connect(t, "alice")

	for range 32 {
		alice.send(unsubscribeFrame(vaultID))
	}

	alice.subscribe(1, vaultID)
}

func TestMalformedAndTextFramesCloseTheConnection(t *testing.T) {
	tests := []struct {
		name        string
		messageType websocket.MessageType
		data        []byte
		wantStatus  websocket.StatusCode
	}{
		{name: "text frame", messageType: websocket.MessageText, data: []byte("hello"), wantStatus: websocket.StatusUnsupportedData},
		{name: "malformed protobuf", messageType: websocket.MessageBinary, data: []byte{0xff, 0xff, 0xff}, wantStatus: websocket.StatusInvalidFramePayloadData},
	}

	fixture := newFixture(t, fixtureOptions{})

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			alice := fixture.connect(t, "alice")

			ctx, cancel := context.WithTimeout(t.Context(), readTimeout)
			defer cancel()

			require.NoError(t, alice.conn.Write(ctx, test.messageType, test.data))

			frame := alice.read()
			require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
			assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, frame.GetError().GetCode())
			assert.True(t, frame.GetError().GetFatal())
			assert.Equal(t, test.wantStatus, alice.closeStatus())
		})
	}
}

// pipeListener serves connections made with net.Pipe, which has no
// buffering: a write blocks until the peer reads it, so a client that stops
// reading stalls the server's writer at once.
type pipeListener struct {
	conns  chan net.Conn
	closed chan struct{}
	once   sync.Once
}

func newPipeListener() *pipeListener {
	return &pipeListener{conns: make(chan net.Conn), closed: make(chan struct{})}
}

func (listener *pipeListener) Accept() (net.Conn, error) {
	select {
	case conn := <-listener.conns:
		return conn, nil
	case <-listener.closed:
		return nil, net.ErrClosed
	}
}

func (listener *pipeListener) Close() error {
	listener.once.Do(func() { close(listener.closed) })

	return nil
}

func (listener *pipeListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1}
}

func (listener *pipeListener) DialContext(ctx context.Context, _, _ string) (net.Conn, error) {
	client, server := net.Pipe()

	select {
	case listener.conns <- server:
		return client, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-listener.closed:
		return nil, net.ErrClosed
	}
}

func TestSlowClientIsDisconnectedInsteadOfBuffered(t *testing.T) {
	listener := newPipeListener()
	fixture := newFixture(t, fixtureOptions{
		// Only the send buffer can end the connection: writes and pings
		// never time out within the test.
		limits:   realtime.Limits{SendBuffer: 4, WriteTimeout: time.Hour, PingInterval: time.Hour},
		listener: listener,
	})

	vaults := make([]uuid.UUID, 3)
	for index := range vaults {
		vaults[index] = fixture.store.createVault("alice")
	}

	conn, _, err := fixture.dial(t, &websocket.DialOptions{
		Subprotocols: bearerProtocols(fixture.token(t, "alice")),
		HTTPClient:   &http.Client{Transport: &http.Transport{DialContext: listener.DialContext}},
	})
	require.NoError(t, err)

	alice := &client{t: t, conn: conn}
	for index, vaultID := range vaults {
		alice.subscribe(uint64(index+1), vaultID) //nolint:gosec // small index.
	}

	// Alice stops reading. The writer blocks on the first frame and the
	// queue fills; one frame beyond it disconnects her.
	for round := 0; fixture.metric(t, "vault_sync_realtime_disconnects_total", "slow_client") == 0; round++ {
		require.Less(t, round, 1000, "the slow client was never disconnected")

		for _, vaultID := range vaults {
			fixture.store.commit(t, vaultID)
		}
	}

	// The connection is gone: reading ends without a flood of queued
	// frames (at most the one the writer was blocked on).
	received := 0

	for {
		if _, err := alice.tryRead(); err != nil {
			break
		}

		received++
	}

	assert.LessOrEqual(t, received, 1)
}

func TestTokenExpiryEndsTheConnectionWithAFatalError(t *testing.T) {
	// The verifier's clock runs a minute behind, so a token expiring in a
	// second is accepted however slow the upgrade; the hub ends the
	// connection at the token's real expiry.
	//
	// Because exp has whole-second precision, the token expires anywhere
	// from 0 to 1 s after the upgrade. The client therefore sends nothing:
	// the first frame it reads must be the fatal error, however quickly
	// or slowly the expiry comes.
	fixture := newFixture(t, fixtureOptions{verifierNow: func() time.Time { return time.Now().Add(-time.Minute) }})

	claims := fixture.issuer.Claims("alice", time.Now().Add(-time.Minute))
	claims["exp"] = time.Now().Add(time.Second).Unix()

	conn, _, err := fixture.dial(t, &websocket.DialOptions{Subprotocols: bearerProtocols(authtest.Sign(t, fixture.key, claims))})
	require.NoError(t, err)

	alice := &client{t: t, conn: conn}

	frame := alice.read()
	require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
	assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, frame.GetError().GetCode())
	assert.True(t, frame.GetError().GetFatal())
	assert.Equal(t, websocket.StatusPolicyViolation, alice.closeStatus())
	// The handler records the reason once it returns.
	require.Eventually(t, func() bool {
		return fixture.metric(t, "vault_sync_realtime_disconnects_total", "token_expired") == 1
	}, readTimeout, 10*time.Millisecond)
}

func TestDrainClosesEveryConnectionWithGoingAway(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	vaultID := fixture.store.createVault("alice")

	clients := []*client{fixture.connect(t, "alice"), fixture.connect(t, "bob")}
	clients[0].subscribe(1, vaultID)

	statuses := make(chan websocket.StatusCode, len(clients))
	for _, client := range clients {
		go func() { statuses <- client.closeStatusAsync() }()
	}

	ctx, cancel := context.WithTimeout(t.Context(), readTimeout)
	defer cancel()

	require.NoError(t, fixture.hub.Drain(ctx))

	for range clients {
		assert.Equal(t, websocket.StatusGoingAway, <-statuses)
	}

	// New upgrades are refused while draining.
	_, response, err := fixture.dial(t, &websocket.DialOptions{Subprotocols: bearerProtocols(fixture.token(t, "alice"))})
	require.Error(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, response.StatusCode)
}

// closeStatusAsync is closeStatus for use off the test goroutine.
func (client *client) closeStatusAsync() websocket.StatusCode {
	for {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(client.t.Context()), readTimeout)
		_, _, err := client.conn.Read(ctx)

		cancel()

		if err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func TestListenerReconnectRecoversMissedCommits(t *testing.T) {
	fixture := newFixture(t, fixtureOptions{})
	vaultID := fixture.store.createVault("alice")

	alice := fixture.connect(t, "alice")
	alice.subscribe(1, vaultID)

	// The listening connection drops; a commit made meanwhile is never
	// announced.
	fixture.store.failListen <- struct{}{}

	seq := fixture.store.advance(vaultID)

	select {
	case <-fixture.store.ready:
	case <-time.After(readTimeout):
		t.Fatal("the hub did not reconnect its listener")
	}

	// After reconnecting the hub announces the current head_seq.
	alice.expectVaultChanged(vaultID, seq)
	assert.Equal(t, 1.0, testutil.ToFloat64(collector(t, fixture, "vault_sync_realtime_listener_reconnects_total")))
}

func collector(t *testing.T, fixture *fixture, name string) prometheus.Collector {
	t.Helper()

	for _, candidate := range fixture.hub.Collectors() {
		description := make(chan *prometheus.Desc, 1)
		candidate.Describe(description)

		if strings.Contains((<-description).String(), `"`+name+`"`) {
			return candidate
		}
	}

	t.Fatalf("no collector %s", name)

	return nil
}
