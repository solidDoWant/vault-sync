package testinfra

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// helperListenerEnv makes the test binary run as a helper process that
// listens on a loopback port, prints its address and waits for stdin to
// close.
const helperListenerEnv = "VAULT_SYNC_TESTINFRA_HELPER_LISTENER"

func TestHelperListener(t *testing.T) {
	if os.Getenv(helperListenerEnv) == "" {
		t.Skip("runs only as the helper process of TestListensOnTellsWhichProcessListensOnAPort")
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	fmt.Println(listener.Addr().String())

	// Holds the listener until the parent closes stdin.
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	_ = listener.Close()
}

// startHelperListener starts another process that listens on a loopback
// port and returns its pid and address.
func startHelperListener(t *testing.T) (int, string) {
	t.Helper()

	helper := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestHelperListener$")

	helper.Env = append(os.Environ(), helperListenerEnv+"=1")

	stdin, err := helper.StdinPipe()
	require.NoError(t, err)

	stdout, err := helper.StdoutPipe()
	require.NoError(t, err)

	require.NoError(t, helper.Start())

	t.Cleanup(func() {
		_ = stdin.Close()
		_ = helper.Wait()
	})

	line, err := bufio.NewReader(stdout).ReadString('\n')
	require.NoError(t, err)

	return helper.Process.Pid, strings.TrimSpace(line)
}

// Not parallel: its listeners on kernel-chosen ports could take a port
// that FreeAddresses handed to a parallel test.
func TestListensOnTellsWhichProcessListensOnAPort(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	t.Cleanup(func() { _ = listener.Close() })

	// A connection this process accepted on a listener it then closed: an
	// open socket on the port, but no listener.
	accepting, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	client, err := net.Dial("tcp", accepting.Addr().String())
	require.NoError(t, err)

	t.Cleanup(func() { _ = client.Close() })

	accepted, err := accepting.Accept()
	require.NoError(t, err)

	t.Cleanup(func() { _ = accepted.Close() })
	require.NoError(t, accepting.Close())

	helperPID, helperAddress := startHelperListener(t)

	tests := []struct {
		name    string
		pid     int
		address string
		want    bool
	}{
		{name: "this process's listener", pid: os.Getpid(), address: listener.Addr().String(), want: true},
		{name: "the other process's listener", pid: helperPID, address: helperAddress, want: true},
		// As a server that has not bound its port yet, while another
		// process serves on it.
		{name: "a listener of another process", pid: os.Getpid(), address: helperAddress, want: false},
		{name: "a listener of this process, asked of another", pid: helperPID, address: listener.Addr().String(), want: false},
		{name: "only a connection on the port", pid: os.Getpid(), address: accepting.Addr().String(), want: false},
		{name: "a process that does not exist", pid: 1 << 30, address: listener.Addr().String(), want: false},
		{name: "not an IPv4 address", pid: os.Getpid(), address: "[::1]:80", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, listensOn(test.pid, test.address))
		})
	}
}
