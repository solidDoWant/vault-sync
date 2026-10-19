//go:build integration

package main_test

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

func buildServer(t *testing.T) string {
	t.Helper()

	binary := filepath.Join(t.TempDir(), "vault-sync-server")

	build := exec.CommandContext(t.Context(), "go", "build", "-o", binary, ".")

	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	output, err := build.CombinedOutput()
	require.NoError(t, err, "go build: %s", output)

	return binary
}

func httpGet(url string) (int, error) {
	response, err := http.Get(url)
	if err != nil {
		return 0, err
	}

	defer func() { _ = response.Body.Close() }()

	_, _ = io.Copy(io.Discard, response.Body)

	return response.StatusCode, nil
}

// TestServerDrainsOnSIGTERM runs the real binary against PostgreSQL, holds
// a request in flight, sends SIGTERM, and checks that the server fails
// /readyz while it still accepts connections, then stops accepting them,
// finishes the request, and exits 0.
func TestServerDrainsOnSIGTERM(t *testing.T) {
	database := testinfra.PostgresConfig(t)
	binary := buildServer(t)

	var server *child

	// Starts a new process, with new addresses, if another process took
	// one of the ports first.
	started := testinfra.StartServer(t, "server", 30*time.Second, func(addresses testinfra.ServerAddresses) testinfra.ServerProcess {
		logs := &bytes.Buffer{}

		server = newChild(t, binary)
		server.Command.Env = []string{
			config.DatabaseURLEnv + "=" + database.DSN,
			config.ListenAddressEnv + "=" + addresses.API,
			config.MetricsListenAddressEnv + "=" + addresses.Metrics,
			config.ShutdownDelayEnv + "=2s",
			config.ShutdownTimeoutEnv + "=20s",
			// The issuer is contacted only to authenticate a request, so an
			// unreachable one does not prevent startup.
			config.OIDCIssuerURLEnv + "=http://127.0.0.1:1/",
			config.OIDCAudienceEnv + "=vault-sync",
		}
		server.Command.Stdout = logs
		server.Command.Stderr = logs

		// Registered before the server's cleanup, so it runs after the
		// server has been stopped and its output collected.
		t.Cleanup(func() {
			if t.Failed() {
				t.Logf("server logs:\n%s", logs.String())
			}
		})

		server.Start(t)

		return testinfra.ServerProcess{Exited: server.Exited(), Err: server.Err, Output: logs.String}
	})
	apiAddress, metricsAddress := started.API, started.Metrics

	status, err := httpGet("http://" + metricsAddress + "/healthz")
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, status)

	// Start a request and wait for "100 Continue", which the server sends
	// only once the handler reads the body: the request is then in flight.
	conn, err := net.Dial("tcp", apiAddress)
	require.NoError(t, err)

	defer func() { _ = conn.Close() }()

	_, err = fmt.Fprint(conn, "POST /vaultsync.v1.ServerInfoService/GetServerInfo HTTP/1.1\r\nHost: vault-sync\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n")
	require.NoError(t, err)

	reader := bufio.NewReader(conn)

	line, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "HTTP/1.1 100 Continue\r\n", line)

	line, err = reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "\r\n", line)

	require.NoError(t, server.Command.Process.Signal(syscall.SIGTERM))

	// Readiness fails first, while the API still accepts connections.
	require.Eventually(t, func() bool {
		status, err := httpGet("http://" + metricsAddress + "/readyz")

		return err == nil && status == http.StatusServiceUnavailable
	}, 10*time.Second, 10*time.Millisecond, "/readyz must fail after SIGTERM")

	probe, err := net.DialTimeout("tcp", apiAddress, time.Second)
	require.NoError(t, err, "the API must still accept connections during the shutdown delay")

	_ = probe.Close()

	require.Eventually(t, func() bool {
		probe, err := net.DialTimeout("tcp", apiAddress, time.Second)
		if err != nil {
			return true
		}

		_ = probe.Close()

		return false
	}, 10*time.Second, 10*time.Millisecond, "server must stop accepting connections after SIGTERM")

	select {
	case <-server.Exited():
		t.Fatalf("server exited before the in-flight request finished: %v", server.Err())
	default:
	}

	_, err = conn.Write([]byte("{}"))
	require.NoError(t, err)

	response, err := http.ReadResponse(reader, nil)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	assert.Equal(t, http.StatusOK, response.StatusCode)

	select {
	case <-server.Exited():
		require.NoError(t, server.Err(), "server must exit 0 after draining")
	case <-time.After(15 * time.Second):
		t.Fatal("server did not exit after draining")
	}
}
