package testinfra

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const (
	// maxExtraPortProbes bounds how many ports one FreeAddresses call may
	// skip because it handed them out before.
	maxExtraPortProbes = 64

	// maxServerStartAttempts bounds how often StartServer starts a server
	// whose port another process took first.
	maxServerStartAttempts = 5

	// readinessPollInterval is how often StartServer probes /readyz.
	readinessPollInterval = 50 * time.Millisecond

	// readinessRequestTimeout bounds one /readyz probe.
	readinessRequestTimeout = 5 * time.Second
)

// portAllocator hands out loopback addresses whose ports were free when it
// probed them, never the same one twice.
type portAllocator struct {
	mu        sync.Mutex
	handedOut map[string]struct{}
	listen    func() (net.Listener, error)
}

func newPortAllocator(listen func() (net.Listener, error)) *portAllocator {
	return &portAllocator{handedOut: map[string]struct{}{}, listen: listen}
}

// listenLoopback opens a listener on a loopback port the kernel picks.
func listenLoopback() (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:0")
}

// processPorts is shared by every test in the test process, so no two of
// them are ever given the same port.
var processPorts = newPortAllocator(listenLoopback)

// take returns count distinct addresses that it has never returned before.
// Every probe listener stays open until all addresses are found, so the
// kernel cannot offer one port twice within a call.
func (ports *portAllocator) take(count int) ([]string, error) {
	ports.mu.Lock()
	defer ports.mu.Unlock()

	var open []net.Listener

	defer func() {
		for _, listener := range open {
			_ = listener.Close()
		}
	}()

	addresses := make([]string, 0, count)
	taken := make(map[string]struct{}, count)

	for probes := 0; len(addresses) < count; probes++ {
		if probes == count+maxExtraPortProbes {
			return nil, fmt.Errorf("found only %d of %d unused loopback ports in %d probes", len(addresses), count, probes)
		}

		listener, err := ports.listen()
		if err != nil {
			return nil, fmt.Errorf("probe for a free loopback port: %w", err)
		}

		open = append(open, listener)

		address := listener.Addr().String()
		if _, seen := ports.handedOut[address]; seen {
			continue
		}

		if _, seen := taken[address]; seen {
			continue
		}

		taken[address] = struct{}{}
		addresses = append(addresses, address)
	}

	for _, address := range addresses {
		ports.handedOut[address] = struct{}{}
	}

	return addresses, nil
}

// FreeAddresses returns count distinct loopback addresses whose ports were
// free a moment ago and that no earlier call in this test process returned.
// Another process may still take a port before the caller binds it; start a
// server with StartServer, which retries when that happens.
func FreeAddresses(t testing.TB, count int) []string {
	t.Helper()

	addresses, err := processPorts.take(count)
	require.NoError(t, err)

	return addresses
}

// ServerAddresses are the listen addresses of a server under test.
type ServerAddresses struct {
	// API is the VAULT_SYNC_LISTEN_ADDRESS.
	API string
	// Metrics is the VAULT_SYNC_METRICS_LISTEN_ADDRESS, which serves
	// /readyz.
	Metrics string
}

// ServerProcess is a started server process, as StartServer observes it.
type ServerProcess struct {
	// Exited is closed once the process has exited and its output is
	// collected.
	Exited <-chan struct{}
	// Err returns the error from waiting for the process. It is called only
	// after Exited is closed.
	Err func() error
	// Output returns the process's combined output. It is called only after
	// Exited is closed.
	Output func() string
}

// StartServer starts a server and waits until its /readyz succeeds. start
// must configure the server with the addresses it is given, start it, and
// return it; StartServer then waits up to readyTimeout for it to become
// ready. When the server exits during startup because one of its ports is
// already in use (another process on the machine took it after
// FreeAddresses probed it), StartServer starts a new server with new
// addresses, up to a fixed number of attempts. Any other exit during startup
// fails the test. name identifies the server in failure messages.
//
// It returns the addresses of the server that became ready.
func StartServer(t testing.TB, name string, readyTimeout time.Duration, start func(ServerAddresses) ServerProcess) ServerAddresses {
	t.Helper()

	starter := serverStarter{
		ports:    processPorts,
		attempts: maxServerStartAttempts,
		ready:    metricsReady,
		poll:     readinessPollInterval,
	}

	addresses, err := starter.start(t.Context(), name, readyTimeout, start)
	require.NoError(t, err)

	return addresses
}

// serverStarter is StartServer with its dependencies made explicit.
type serverStarter struct {
	ports    *portAllocator
	attempts int
	ready    func(ctx context.Context, metricsAddress string) bool
	poll     time.Duration
}

// errAddressInUse marks a server that exited because a port was taken.
var errAddressInUse = errors.New("a listen address was already in use")

func (starter serverStarter) start(ctx context.Context, name string, readyTimeout time.Duration, start func(ServerAddresses) ServerProcess) (ServerAddresses, error) {
	var last error

	for attempt := 1; attempt <= starter.attempts; attempt++ {
		addresses, err := starter.ports.take(2)
		if err != nil {
			return ServerAddresses{}, err
		}

		server := ServerAddresses{API: addresses[0], Metrics: addresses[1]}

		err = starter.awaitReady(ctx, name, readyTimeout, server, start(server))
		if err == nil {
			return server, nil
		}

		if !errors.Is(err, errAddressInUse) {
			return ServerAddresses{}, err
		}

		last = err
	}

	return ServerAddresses{}, fmt.Errorf("%s: gave up after %d attempts: %w", name, starter.attempts, last)
}

func (starter serverStarter) awaitReady(ctx context.Context, name string, readyTimeout time.Duration, addresses ServerAddresses, process ServerProcess) error {
	deadline := time.NewTimer(readyTimeout)
	defer deadline.Stop()

	ticker := time.NewTicker(starter.poll)
	defer ticker.Stop()

	for {
		select {
		case <-process.Exited:
			output := process.Output()
			if addressInUse(output) {
				return fmt.Errorf("%w: %s exited during startup on %s and %s: %w\n%s",
					errAddressInUse, name, addresses.API, addresses.Metrics, process.Err(), output)
			}

			return fmt.Errorf("%s exited during startup: %w\n%s", name, process.Err(), output)
		default:
		}

		if starter.ready(ctx, addresses.Metrics) {
			return nil
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("%s: waiting for readiness: %w", name, context.Cause(ctx))
		case <-deadline.C:
			return fmt.Errorf("%s did not become ready within %s", name, readyTimeout)
		case <-process.Exited:
		case <-ticker.C:
		}
	}
}

// addressInUse reports whether output shows a failure to bind an address
// that is already in use, in the wording of Linux and macOS or of Windows.
func addressInUse(output string) bool {
	return strings.Contains(output, "address already in use") ||
		strings.Contains(output, "Only one usage of each socket address")
}

// metricsReady reports whether /readyz on metricsAddress returns 200.
func metricsReady(ctx context.Context, metricsAddress string) bool {
	ctx, cancel := context.WithTimeout(ctx, readinessRequestTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+metricsAddress+"/readyz", nil)
	if err != nil {
		return false
	}

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}

	defer func() { _ = response.Body.Close() }()

	_, _ = io.Copy(io.Discard, response.Body)

	return response.StatusCode == http.StatusOK
}
