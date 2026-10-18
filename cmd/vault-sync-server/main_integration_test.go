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

func freeAddress(t *testing.T) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	address := listener.Addr().String()
	require.NoError(t, listener.Close())

	return address
}

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
// a request in flight, sends SIGTERM, and checks that the server stops
// accepting connections, finishes the request, and exits 0.
func TestServerDrainsOnSIGTERM(t *testing.T) {
	database := testinfra.PostgresConfig(t)
	binary := buildServer(t)

	apiAddress := freeAddress(t)
	metricsAddress := freeAddress(t)

	var logs bytes.Buffer

	command := exec.CommandContext(t.Context(), binary)
	command.Env = []string{
		config.DatabaseURLEnv + "=" + database.DSN,
		config.ListenAddressEnv + "=" + apiAddress,
		config.MetricsListenAddressEnv + "=" + metricsAddress,
		config.ShutdownTimeoutEnv + "=20s",
	}
	command.Stdout = &logs
	command.Stderr = &logs
	require.NoError(t, command.Start())

	exited := make(chan error, 1)

	go func() { exited <- command.Wait() }()

	t.Cleanup(func() {
		_ = command.Process.Kill()

		if t.Failed() {
			t.Logf("server logs:\n%s", logs.String())
		}
	})

	require.Eventually(t, func() bool {
		status, err := httpGet("http://" + metricsAddress + "/readyz")

		return err == nil && status == http.StatusOK
	}, 30*time.Second, 50*time.Millisecond, "server must become ready")

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

	require.NoError(t, command.Process.Signal(syscall.SIGTERM))

	require.Eventually(t, func() bool {
		probe, err := net.DialTimeout("tcp", apiAddress, time.Second)
		if err != nil {
			return true
		}

		_ = probe.Close()

		return false
	}, 10*time.Second, 10*time.Millisecond, "server must stop accepting connections after SIGTERM")

	select {
	case err := <-exited:
		t.Fatalf("server exited before the in-flight request finished: %v", err)
	default:
	}

	_, err = conn.Write([]byte("{}"))
	require.NoError(t, err)

	response, err := http.ReadResponse(reader, nil)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	assert.Equal(t, http.StatusOK, response.StatusCode)

	select {
	case err := <-exited:
		require.NoError(t, err, "server must exit 0 after draining")
	case <-time.After(15 * time.Second):
		t.Fatal("server did not exit after draining")
	}
}
