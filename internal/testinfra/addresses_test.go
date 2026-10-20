package testinfra

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeListener is a probe listener bound to a fixed port.
type fakeListener struct {
	address *net.TCPAddr
	closed  *int
}

func (listener fakeListener) Accept() (net.Conn, error) { return nil, errors.New("not implemented") }
func (listener fakeListener) Addr() net.Addr            { return listener.address }

func (listener fakeListener) Close() error {
	*listener.closed++

	return nil
}

// scriptedPorts returns an allocator whose probes get the given ports in
// order, as a kernel that offers the same port again would, and counts
// closed listeners.
func scriptedPorts(t *testing.T, ports ...uint16) (*portAllocator, *int) {
	t.Helper()

	closed := 0
	next := 0

	allocator := newPortAllocator(func() (net.Listener, error) {
		require.Less(t, next, len(ports), "more probes than scripted ports")

		port := ports[next]
		next++

		return fakeListener{
			address: net.TCPAddrFromAddrPort(netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), port)),
			closed:  &closed,
		}, nil
	})

	return allocator, &closed
}

func TestPortAllocatorNeverReturnsAPortTwice(t *testing.T) {
	t.Parallel()

	ports, closed := scriptedPorts(t, 1001, 1001, 1002, 1002, 1001, 1003, 1004)

	first, err := ports.take(2)
	require.NoError(t, err)
	assert.Equal(t, []string{"127.0.0.1:1001", "127.0.0.1:1002"}, first, "a port offered twice in one call is skipped")

	second, err := ports.take(2)
	require.NoError(t, err)
	assert.Equal(t, []string{"127.0.0.1:1003", "127.0.0.1:1004"}, second, "ports of an earlier call are skipped")

	assert.Equal(t, 7, *closed, "every probe listener is closed")
}

func TestPortAllocatorKeepsProbesOpenUntilItHasAllPorts(t *testing.T) {
	t.Parallel()

	closed := 0
	closedAtProbe := []int{}
	next := uint16(3001)

	ports := newPortAllocator(func() (net.Listener, error) {
		closedAtProbe = append(closedAtProbe, closed)
		port := next
		next++

		return fakeListener{
			address: net.TCPAddrFromAddrPort(netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), port)),
			closed:  &closed,
		}, nil
	})

	_, err := ports.take(3)
	require.NoError(t, err)

	// While a probe listener is open the kernel cannot offer its port to
	// the next probe.
	assert.Equal(t, []int{0, 0, 0}, closedAtProbe, "no probe listener is closed before the last probe")
	assert.Equal(t, 3, closed, "every probe listener is closed afterwards")
}

func TestPortAllocatorGivesUpAfterBoundedProbes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		repeats     int
		errorAssert require.ErrorAssertionFunc
	}{
		// One fresh port, then the second must come within the probe
		// budget: count + maxExtraPortProbes probes in total.
		{name: "last allowed probe finds the port", repeats: maxExtraPortProbes, errorAssert: require.NoError},
		{name: "one repeat too many", repeats: maxExtraPortProbes + 1, errorAssert: require.Error},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			script := []uint16{2001}
			for range test.repeats {
				script = append(script, 2001)
			}

			script = append(script, 2002)

			ports, _ := scriptedPorts(t, script...)

			addresses, err := ports.take(2)
			test.errorAssert(t, err)

			if err == nil {
				assert.Equal(t, []string{"127.0.0.1:2001", "127.0.0.1:2002"}, addresses)
			}
		})
	}
}

func TestFreeAddressesAreDistinctAcrossCalls(t *testing.T) {
	t.Parallel()

	// A real kernel, but not the process-wide allocator: the ports that one
	// hands out stay taken for the rest of the process, so -count=50 would
	// use up the kernel's ephemeral port range.
	ports := newPortAllocator(listenLoopback)
	seen := map[string]struct{}{}

	for range 200 {
		addresses, err := ports.take(2)
		require.NoError(t, err)

		for _, address := range addresses {
			_, duplicate := seen[address]
			require.False(t, duplicate, "address %s returned twice", address)

			seen[address] = struct{}{}
		}
	}
}

func TestFreeAddressesAreBindable(t *testing.T) {
	t.Parallel()

	for _, address := range FreeAddresses(t, 2) {
		listener, err := net.Listen("tcp", address)
		require.NoError(t, err)
		require.NoError(t, listener.Close())
	}
}

// fakeServers records the attempts of a serverStarter and plays one scripted
// outcome per attempt.
type fakeServers struct {
	outcomes []serverOutcome
	attempts []ServerAddresses
	readyOn  string
	// foreign makes every /readyz probe succeed, as another process's
	// server on the probed port would answer it.
	foreign bool
	// checks counts the ownership checks of the current attempt.
	checks int
	// exitLater is closed by the current attempt's second ownership check.
	exitLater chan struct{}
}

type serverOutcome struct {
	// exitOutput, if set, makes the server exit with this output: at once,
	// or, with exitLater, only once StartServer has checked twice whether
	// it listens (still starting at first, then failing to bind).
	exitOutput string
	exitLater  bool
	// ready makes the server listen on its addresses and answer /readyz.
	ready bool
}

func (servers *fakeServers) start(addresses ServerAddresses) ServerProcess {
	outcome := servers.outcomes[len(servers.attempts)]
	servers.attempts = append(servers.attempts, addresses)
	servers.checks = 0
	servers.exitLater = nil

	exited := make(chan struct{})

	switch {
	case outcome.exitOutput != "" && outcome.exitLater:
		servers.exitLater = exited
	case outcome.exitOutput != "":
		close(exited)
	}

	if outcome.ready {
		servers.readyOn = addresses.Metrics
	}

	return ServerProcess{
		Exited: exited,
		Err:    func() error { return errors.New("exit status 1") },
		Output: func() string { return outcome.exitOutput },
		PID:    len(servers.attempts),
	}
}

func (servers *fakeServers) ready(_ context.Context, metricsAddress string) bool {
	return servers.foreign || (servers.readyOn != "" && metricsAddress == servers.readyOn)
}

// owns reports whether the attempt with pid listens on address.
func (servers *fakeServers) owns(pid int, address string) bool {
	servers.checks++
	if servers.checks == 2 && servers.exitLater != nil {
		close(servers.exitLater)
		servers.exitLater = nil
	}

	return pid == len(servers.attempts) && servers.readyOn == address
}

// starter returns a serverStarter that plays servers' outcomes.
func (servers *fakeServers) starter(attempts int) serverStarter {
	return serverStarter{
		ports:    newPortAllocator(listenLoopback),
		attempts: attempts,
		ready:    servers.ready,
		owns:     servers.owns,
		poll:     time.Millisecond,
	}
}

const (
	linuxAddressInUse   = `{"level":"ERROR","msg":"server stopped with an error","error":"listen for API: listen tcp 127.0.0.1:41000: bind: address already in use"}`
	windowsAddressInUse = `{"level":"ERROR","msg":"server stopped with an error","error":"listen for metrics: listen tcp 127.0.0.1:41001: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted."}`
	otherStartupFailure = `{"level":"ERROR","msg":"invalid configuration","error":"VAULT_SYNC_OIDC_ISSUER_URL is required"}`
)

func TestServerStarterRetriesWhenAPortIsTaken(t *testing.T) {
	t.Parallel()

	servers := &fakeServers{outcomes: []serverOutcome{
		{exitOutput: linuxAddressInUse},
		{exitOutput: windowsAddressInUse},
		{ready: true},
	}}

	starter := servers.starter(3)

	addresses, err := starter.start(t.Context(), "server", time.Minute, servers.start)
	require.NoError(t, err)

	require.Len(t, servers.attempts, 3)
	assert.Equal(t, servers.attempts[2], addresses, "returns the addresses of the server that became ready")

	used := map[string]struct{}{}

	for _, attempt := range servers.attempts {
		assert.NotEqual(t, attempt.API, attempt.Metrics, "API and metrics ports differ")

		for _, address := range []string{attempt.API, attempt.Metrics} {
			_, reused := used[address]
			assert.False(t, reused, "a retry gets new addresses, not %s again", address)

			used[address] = struct{}{}
		}
	}
}

func TestServerStarterIgnoresAnotherProcesssServerOnItsPort(t *testing.T) {
	t.Parallel()

	// Another process's server took the metrics port after it was probed
	// and answers /readyz with 200 while the first attempt's server is
	// still starting (connecting to PostgreSQL, migrating); that server
	// then fails to bind the port.
	servers := &fakeServers{foreign: true, outcomes: []serverOutcome{
		{exitOutput: linuxAddressInUse, exitLater: true},
		{ready: true},
	}}

	addresses, err := servers.starter(3).start(t.Context(), "server", time.Minute, servers.start)
	require.NoError(t, err)

	require.Len(t, servers.attempts, 2, "the attempt that could not bind is retried")
	assert.Equal(t, servers.attempts[1], addresses, "returns the addresses of the server that listens on them")
}

func TestServerStarterGivesUpAfterBoundedAttempts(t *testing.T) {
	t.Parallel()

	const attempts = 3

	servers := &fakeServers{outcomes: []serverOutcome{
		{exitOutput: linuxAddressInUse},
		{exitOutput: linuxAddressInUse},
		{exitOutput: linuxAddressInUse},
		// Never reached: the starter must not make a fourth attempt.
		{ready: true},
	}}

	starter := servers.starter(attempts)

	_, err := starter.start(t.Context(), "server", time.Minute, servers.start)
	require.Error(t, err)
	assert.ErrorContains(t, err, "address already in use")
	assert.Len(t, servers.attempts, attempts)
}

func TestServerStarterDoesNotRetryOtherStartupFailures(t *testing.T) {
	t.Parallel()

	servers := &fakeServers{outcomes: []serverOutcome{
		{exitOutput: otherStartupFailure},
		{ready: true},
	}}

	starter := servers.starter(3)

	_, err := starter.start(t.Context(), "killed-while-committing", time.Minute, servers.start)
	require.Error(t, err)
	assert.ErrorContains(t, err, "killed-while-committing exited during startup")
	assert.ErrorContains(t, err, "VAULT_SYNC_OIDC_ISSUER_URL is required", "the error includes the server's output")
	assert.Len(t, servers.attempts, 1)
}

func TestServerStarterFailsWhenNeverReady(t *testing.T) {
	t.Parallel()

	servers := &fakeServers{outcomes: []serverOutcome{{}, {ready: true}}}

	starter := servers.starter(3)

	_, err := starter.start(t.Context(), "server", 20*time.Millisecond, servers.start)
	require.Error(t, err)
	assert.ErrorContains(t, err, "did not become ready")
	assert.Len(t, servers.attempts, 1, "a server that is merely slow is not restarted")
}
