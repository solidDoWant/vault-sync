// Package realtime serves the realtime channel (SPEC.md §6.4): one
// authenticated WebSocket per device, on which the client subscribes to any
// number of its vaults (up to a cap) and receives vault_changed{vault_id, seq}
// after every commit.
//
// Commits are announced through PostgreSQL LISTEN/NOTIFY (store.ListenVaultChanges),
// so a client connected to any server replica hears about commits made on
// every replica (SPEC.md §12). The channel is a latency optimization only:
// clients still pull with ListChanges, so a missed notification costs latency,
// never correctness.
//
// Every subscribe is authorized against vault_members, and membership is
// checked again before every delivery, so a member removed from a vault stops
// receiving its notifications. Every resource a client can consume is bounded:
// connections per user and per instance, subscriptions per connection,
// inbound frame size and rate, and the outbound buffer of each connection (a
// client too slow to keep up is disconnected).
//
// Tokens, and the Sec-WebSocket-Protocol header that carries them, are never
// logged.
package realtime

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Path is the HTTP path of the WebSocket endpoint.
const Path = "/v1/realtime"

// Subprotocols. A client offers Subprotocol, and a browser client (which
// cannot set headers on a WebSocket request) also offers
// BearerSubprotocolPrefix followed by its access token. The server echoes
// only Subprotocol.
const (
	Subprotocol             = "vaultsync.v1"
	BearerSubprotocolPrefix = "vaultsync.bearer."
)

// Default limits.
const (
	DefaultMaxConnections        = 10000
	DefaultMaxConnectionsPerUser = 32
	DefaultMaxSubscriptions      = 128

	// DefaultMaxFrameBytes bounds an inbound frame. Client frames are a
	// subscribe or unsubscribe naming one vault, well under 100 bytes.
	DefaultMaxFrameBytes = 4 << 10
	// DefaultFramesPerSecond is the sustained inbound frame rate. A client
	// may burst MaxSubscriptions + frameBurstSlack frames, enough to
	// subscribe to every vault at once after a reconnect.
	DefaultFramesPerSecond = 20
	frameBurstSlack        = 32

	DefaultWriteTimeout = 10 * time.Second
	DefaultPingInterval = 30 * time.Second
)

// Timeouts of database work done for a connection.
const (
	queryTimeout = 10 * time.Second
	// resyncBatch bounds the vaults looked up in one query after the
	// listener reconnects.
	resyncBatch = 1000
)

// membershipBatch bounds the users whose membership of one vault is checked
// in one query before a delivery. It is a variable only so tests can lower
// it.
var membershipBatch = 1000

// Backoff between attempts to reconnect the notification listener.
const (
	minListenBackoff = 500 * time.Millisecond
	maxListenBackoff = 30 * time.Second
)

// Limits bound the resources clients can use. Zero fields take their
// defaults.
type Limits struct {
	// MaxConnections bounds this instance's open connections.
	MaxConnections int
	// MaxConnectionsPerUser bounds one user's open connections to this
	// instance.
	MaxConnectionsPerUser int
	// MaxSubscriptions bounds the vaults one connection subscribes to.
	MaxSubscriptions int
	// MaxFrameBytes bounds an inbound frame; a larger one closes the
	// connection with status 1009.
	MaxFrameBytes int64
	// FramesPerSecond is the sustained inbound frame rate allowed. Bursts
	// of MaxSubscriptions + 32 frames are allowed.
	FramesPerSecond float64
	// SendBuffer bounds the frames queued for one connection. A connection
	// whose queue is full is closed. Defaults to 2 * MaxSubscriptions + 16:
	// a subscribed and a vault_changed frame for every subscription.
	SendBuffer int
	// WriteTimeout bounds writing one frame.
	WriteTimeout time.Duration
	// PingInterval is how often the server pings each client; a client that
	// does not answer within WriteTimeout is disconnected.
	PingInterval time.Duration
}

func (limits Limits) withDefaults() Limits {
	setDefault(&limits.MaxConnections, DefaultMaxConnections)
	setDefault(&limits.MaxConnectionsPerUser, DefaultMaxConnectionsPerUser)
	setDefault(&limits.MaxSubscriptions, DefaultMaxSubscriptions)
	setDefault(&limits.MaxFrameBytes, DefaultMaxFrameBytes)
	setDefault(&limits.FramesPerSecond, DefaultFramesPerSecond)
	setDefault(&limits.SendBuffer, 2*limits.MaxSubscriptions+16)
	setDefault(&limits.WriteTimeout, DefaultWriteTimeout)
	setDefault(&limits.PingInterval, DefaultPingInterval)

	return limits
}

func setDefault[T int | int64 | float64 | time.Duration](value *T, fallback T) {
	if *value <= 0 {
		*value = fallback
	}
}

// Store is the database access the hub needs. *store.Store implements it.
type Store interface {
	// VaultMembers returns which of userIDs are members of vaultID (none
	// when the vault does not exist), in one query. For a deleted vault it
	// returns the members together with store.ErrVaultDeleted.
	VaultMembers(ctx context.Context, vaultID uuid.UUID, userIDs []uuid.UUID) (map[uuid.UUID]bool, error)
	// MemberHeadSeq returns userID's role in vaultID and the vault's
	// head_seq, in one query. It returns store.ErrVaultNotFound both when
	// the vault does not exist and when the user is not a member, and
	// store.ErrVaultDeleted to a member of a deleted vault.
	MemberHeadSeq(ctx context.Context, vaultID, userID uuid.UUID) (store.Role, int64, error)
	// HeadSeqs returns the head_seq of each existing vault in vaultIDs.
	HeadSeqs(ctx context.Context, vaultIDs []uuid.UUID) (map[uuid.UUID]int64, error)
	// ListenVaultChanges delivers every committed vault change until ctx
	// ends (returning nil) or its connection fails (returning the error).
	ListenVaultChanges(ctx context.Context, options store.ListenOptions) error
}

// Options configures a Hub.
type Options struct {
	// Authenticator validates the bearer token of every upgrade. When nil,
	// every upgrade is refused.
	Authenticator *auth.Authenticator
	// Store resolves memberships and delivers commits.
	Store Store
	// AllowedOrigins are the browser origins allowed to connect. Requests
	// without an Origin header (non-browser clients) are allowed.
	AllowedOrigins []string
	// Limits bound clients' resources.
	Limits Limits
	// ListenHealthInterval is passed to the notification listener; zero
	// means store.DefaultListenHealthInterval.
	ListenHealthInterval time.Duration
	// Logger defaults to discarding logs.
	Logger *slog.Logger
}

// Hub serves the realtime channel and fans commits out to subscribers.
type Hub struct {
	options Options
	limits  Limits
	origins map[string]bool
	logger  *slog.Logger
	metrics *metrics

	// stop ends Run; it is closed by Drain.
	stop     chan struct{}
	stopOnce sync.Once

	// handlers counts admitted upgrades until their handler returns.
	handlers sync.WaitGroup

	mu       sync.Mutex
	draining bool
	// admittedCount counts admitted upgrades until their handler returns.
	admittedCount int
	connections   map[*connection]struct{}
	perUser       map[uuid.UUID]int
	// subscribers indexes connections by the vaults they subscribe to.
	subscribers map[uuid.UUID]map[*connection]struct{}

	// pending holds the newest seq of each vault with notifications not yet
	// delivered; wake signals the delivery loop.
	pendingMu sync.Mutex
	pending   map[uuid.UUID]int64
	wake      chan struct{}
}

// NewHub builds a Hub. Serve its upgrades with ServeHTTP, deliver commits by
// running Run, and close its connections with Drain.
func NewHub(options Options) *Hub {
	if options.Logger == nil {
		options.Logger = slog.New(slog.DiscardHandler)
	}

	origins := make(map[string]bool, len(options.AllowedOrigins))
	for _, origin := range options.AllowedOrigins {
		origins[origin] = true
	}

	return &Hub{
		options:     options,
		limits:      options.Limits.withDefaults(),
		origins:     origins,
		logger:      options.Logger,
		metrics:     newMetrics(),
		stop:        make(chan struct{}),
		connections: make(map[*connection]struct{}),
		perUser:     make(map[uuid.UUID]int),
		subscribers: make(map[uuid.UUID]map[*connection]struct{}),
		pending:     make(map[uuid.UUID]int64),
		wake:        make(chan struct{}, 1),
	}
}

// MaxSubscriptions returns the subscriptions allowed per connection, which
// GetServerInfo reports to clients.
func (hub *Hub) MaxSubscriptions() int {
	return hub.limits.MaxSubscriptions
}

// Run listens for commits and delivers them to subscribers until ctx ends or
// Drain is called. When the listening database connection fails it
// reconnects with backoff, and once reconnected notifies every subscribed
// vault's current head_seq, so commits made while it was disconnected are
// not missed.
func (hub *Hub) Run(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	go func() {
		select {
		case <-hub.stop:
			cancel()
		case <-ctx.Done():
		}
	}()

	var delivery sync.WaitGroup

	delivery.Go(func() { hub.deliverLoop(ctx) })
	defer delivery.Wait()

	backoff := minListenBackoff

	for {
		err := hub.options.Store.ListenVaultChanges(ctx, store.ListenOptions{
			HealthInterval: hub.options.ListenHealthInterval,
			Ready: func(ctx context.Context) {
				hub.metrics.listenerUp.Set(1)
				hub.logger.InfoContext(ctx, "realtime notification listener connected")

				backoff = minListenBackoff

				hub.resync(ctx)
			},
			Handle: hub.publish,
		})

		hub.metrics.listenerUp.Set(0)

		if ctx.Err() != nil {
			return
		}

		if err == nil {
			err = errors.New("listener stopped")
		}

		// Jitter spreads the replicas' reconnects after a database restart.
		delay := backoff/2 + rand.N(backoff/2+1)

		hub.metrics.listenerReconnects.Inc()
		hub.logger.WarnContext(ctx, "realtime notification listener lost its database connection; reconnecting",
			"error", err, "retry_in", delay.String())

		timer := time.NewTimer(delay)

		select {
		case <-ctx.Done():
			timer.Stop()

			return
		case <-timer.C:
		}

		backoff = min(2*backoff, maxListenBackoff)
	}
}

// resync queues a notification of the current head_seq of every subscribed
// vault. Clients whose cursor is already there do nothing.
func (hub *Hub) resync(ctx context.Context) {
	hub.mu.Lock()

	vaults := make([]uuid.UUID, 0, len(hub.subscribers))
	for vaultID := range hub.subscribers {
		vaults = append(vaults, vaultID)
	}

	hub.mu.Unlock()

	for start := 0; start < len(vaults); start += resyncBatch {
		batch := vaults[start:min(start+resyncBatch, len(vaults))]

		queryCtx, cancel := context.WithTimeout(ctx, queryTimeout)
		heads, err := hub.options.Store.HeadSeqs(queryCtx, batch)

		cancel()

		if err != nil {
			hub.logger.WarnContext(ctx, "cannot look up head_seqs after the realtime listener reconnected", "error", err)

			return
		}

		for vaultID, headSeq := range heads {
			hub.publish(store.VaultChange{VaultID: vaultID, Seq: headSeq})
		}
	}
}

// publish queues a vault change for delivery, coalescing it with any
// undelivered change of the same vault. Changes of vaults nobody here
// subscribes to are dropped, so the queue is bounded by the subscriptions.
func (hub *Hub) publish(change store.VaultChange) {
	hub.mu.Lock()
	_, subscribed := hub.subscribers[change.VaultID]
	hub.mu.Unlock()

	if !subscribed {
		return
	}

	// A membership removal is announced at the vault's head_seq, which is
	// zero for a vault without revisions; it must still be queued, so its
	// subscribers' membership is checked.
	hub.pendingMu.Lock()
	if pending, queued := hub.pending[change.VaultID]; !queued || change.Seq > pending {
		hub.pending[change.VaultID] = change.Seq
	}
	hub.pendingMu.Unlock()

	select {
	case hub.wake <- struct{}{}:
	default:
	}
}

func (hub *Hub) deliverLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-hub.wake:
		}

		hub.pendingMu.Lock()
		pending := hub.pending
		hub.pending = make(map[uuid.UUID]int64)
		hub.pendingMu.Unlock()

		for vaultID, seq := range pending {
			hub.deliver(ctx, vaultID, seq)
		}
	}
}

// deliver sends vault_changed to the vault's subscribers whose user is still
// a member. A removed member's subscriptions to the vault end, with a
// NOT_FOUND error frame. Membership is checked in one query per
// membershipBatch subscribed users, so a busy vault costs one database round
// trip rather than one per user.
func (hub *Hub) deliver(ctx context.Context, vaultID uuid.UUID, seq int64) {
	byUser := make(map[uuid.UUID][]*connection)

	hub.mu.Lock()

	for conn := range hub.subscribers[vaultID] {
		subscription := conn.subscriptions[vaultID]
		if !subscription.confirmed {
			// The subscribe is still being authorized; it reports
			// this seq in its subscribed frame instead.
			subscription.pendingSeq = max(subscription.pendingSeq, seq)

			continue
		}

		byUser[conn.user.ID] = append(byUser[conn.user.ID], conn)
	}

	hub.mu.Unlock()

	users := make([]uuid.UUID, 0, len(byUser))
	for userID := range byUser {
		users = append(users, userID)
	}

	for start := 0; start < len(users); start += membershipBatch {
		batch := users[start:min(start+membershipBatch, len(users))]

		queryCtx, cancel := context.WithTimeout(ctx, queryTimeout)
		members, err := hub.options.Store.VaultMembers(queryCtx, vaultID, batch)

		cancel()

		deleted := errors.Is(err, store.ErrVaultDeleted)
		if deleted {
			err = nil
		}

		if err != nil {
			// Fail closed; the clients' fallback pull catches up.
			if ctx.Err() == nil {
				hub.logger.WarnContext(ctx, "cannot check vault membership for a realtime notification", "error", err)
			}

			continue
		}

		for _, userID := range batch {
			hub.deliverToUser(vaultID, seq, byUser[userID], members[userID], deleted)
		}
	}
}

// deliverToUser sends vault_changed to one user's subscribed connections if
// the user is still a member of the vault, and otherwise ends their
// subscriptions with a NOT_FOUND error frame. A member of a deleted vault
// gets NOT_FOUND with reason ERROR_REASON_VAULT_DELETED.
func (hub *Hub) deliverToUser(vaultID uuid.UUID, seq int64, conns []*connection, member, deleted bool) {
	for _, conn := range conns {
		if !member || deleted {
			if hub.unsubscribe(conn, vaultID) {
				if member {
					conn.enqueue(vaultDeletedFrame(0, vaultID))
				} else {
					conn.enqueue(notFoundFrame(0, vaultID))
				}
			}

			continue
		}

		if hub.subscribed(conn, vaultID) {
			hub.metrics.notifications.Inc()
			conn.enqueue(vaultChangedFrame(vaultID, seq))
		}
	}
}

// subscription is one connection's subscription to one vault.
type subscription struct {
	// confirmed is false while the subscribe is being authorized.
	confirmed bool
	// pendingSeq is the newest seq announced while unconfirmed.
	pendingSeq int64
}

// errSubscriptionLimit is returned by subscribe when the connection already
// has the maximum number of subscriptions.
var errSubscriptionLimit = errors.New("subscription limit reached")

// beginSubscribe registers an unconfirmed subscription before it is
// authorized, so no commit made meanwhile is missed. It reports whether the
// connection was already subscribed (confirmed).
func (hub *Hub) beginSubscribe(conn *connection, vaultID uuid.UUID) (bool, error) {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	if existing, ok := conn.subscriptions[vaultID]; ok {
		return existing.confirmed, nil
	}

	if len(conn.subscriptions) >= hub.limits.MaxSubscriptions {
		return false, errSubscriptionLimit
	}

	conn.subscriptions[vaultID] = &subscription{}

	if hub.subscribers[vaultID] == nil {
		hub.subscribers[vaultID] = make(map[*connection]struct{})
	}

	hub.subscribers[vaultID][conn] = struct{}{}

	return false, nil
}

// confirmSubscribe marks the subscription authorized and returns the newest
// seq announced while it was not. It returns false if the subscription ended
// meanwhile.
func (hub *Hub) confirmSubscribe(conn *connection, vaultID uuid.UUID) (int64, bool) {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	subscription, ok := conn.subscriptions[vaultID]
	if !ok {
		return 0, false
	}

	subscription.confirmed = true
	pendingSeq := subscription.pendingSeq
	subscription.pendingSeq = 0

	return pendingSeq, true
}

// unsubscribe ends conn's subscription to vaultID and reports whether it
// existed.
func (hub *Hub) unsubscribe(conn *connection, vaultID uuid.UUID) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	return hub.unsubscribeLocked(conn, vaultID)
}

func (hub *Hub) unsubscribeLocked(conn *connection, vaultID uuid.UUID) bool {
	if _, ok := conn.subscriptions[vaultID]; !ok {
		return false
	}

	delete(conn.subscriptions, vaultID)
	delete(hub.subscribers[vaultID], conn)

	if len(hub.subscribers[vaultID]) == 0 {
		delete(hub.subscribers, vaultID)
	}

	return true
}

func (hub *Hub) subscribed(conn *connection, vaultID uuid.UUID) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	subscription, ok := conn.subscriptions[vaultID]

	return ok && subscription.confirmed
}

// admission is why an upgrade was refused before it was accepted.
type admission int

const (
	admitted admission = iota
	refusedDraining
	refusedInstanceLimit
	refusedUserLimit
)

// admit reserves a connection slot for userID.
func (hub *Hub) admit(userID uuid.UUID) admission {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	switch {
	case hub.draining:
		return refusedDraining
	case hub.admittedCount >= hub.limits.MaxConnections:
		return refusedInstanceLimit
	case hub.perUser[userID] >= hub.limits.MaxConnectionsPerUser:
		return refusedUserLimit
	}

	hub.admittedCount++
	hub.perUser[userID]++
	hub.handlers.Add(1)

	return admitted
}

// release frees the slot admit reserved.
func (hub *Hub) release(userID uuid.UUID) {
	hub.mu.Lock()

	hub.admittedCount--

	hub.perUser[userID]--
	if hub.perUser[userID] <= 0 {
		delete(hub.perUser, userID)
	}

	hub.mu.Unlock()
	hub.handlers.Done()
}

// register adds an accepted connection. It returns false when the hub
// started draining since admit.
func (hub *Hub) register(conn *connection) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	if hub.draining {
		return false
	}

	hub.connections[conn] = struct{}{}
	hub.metrics.connections.Set(float64(len(hub.connections)))

	return true
}

// unregister removes a connection and all its subscriptions.
func (hub *Hub) unregister(conn *connection) {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	for vaultID := range conn.subscriptions {
		hub.unsubscribeLocked(conn, vaultID)
	}

	delete(hub.connections, conn)
	hub.metrics.connections.Set(float64(len(hub.connections)))
}

// Drain implements server.Drainer: it refuses new upgrades, stops Run, and
// closes every connection with status 1001 ("going away") so clients
// reconnect to another instance. It returns once every connection is closed,
// or with ctx's error after closing the remaining ones abruptly.
func (hub *Hub) Drain(ctx context.Context) error {
	hub.mu.Lock()
	hub.draining = true

	conns := make([]*connection, 0, len(hub.connections))
	for conn := range hub.connections {
		conns = append(conns, conn)
	}

	hub.mu.Unlock()

	hub.stopOnce.Do(func() { close(hub.stop) })

	for _, conn := range conns {
		conn.close(closeGoingAway)
	}

	done := make(chan struct{})

	go func() {
		hub.handlers.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		for _, conn := range conns {
			conn.abort(reasonDrain)
		}

		return ctx.Err()
	}
}
