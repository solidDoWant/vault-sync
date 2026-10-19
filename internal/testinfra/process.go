package testinfra

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The child-process helpers below start the server, node and vitest for
// every test that runs them: cmd/vault-sync-server's integration and e2e
// tests and the simulation driver in sim/.

const (
	// maxChildGrace caps how long before the test binary's deadline a
	// child's context ends.
	maxChildGrace = 5 * time.Second

	// childWaitDelay bounds how long waiting for a child blocks on output
	// pipes that a descendant still holds open after the child exited.
	childWaitDelay = 5 * time.Second
)

// ErrTestDeadline is the cause of a child's context ending because the test
// binary's -timeout is about to fire.
var ErrTestDeadline = errors.New("killed before `go test -timeout` fires")

// Child is a child process of the test that, together with every descendant
// of it, dies with the test even when the test does not finish normally:
//
//   - When `go test -timeout` fires, the test binary panics without running
//     t.Cleanup. The child's context therefore ends shortly before the test
//     binary's deadline, and exec's own watcher goroutine then kills the
//     child's process group, wherever the test goroutine is blocked.
//   - On Linux, the child leads its own process group, and cancellation and
//     cleanup kill the whole group, so grandchildren (vitest's workers) die
//     too, not only the direct child.
//   - On Linux, the kernel also SIGKILLs the direct child when the test
//     binary dies for any other reason, e.g. it is killed itself (Pdeathsig;
//     see Start).
type Child struct {
	// Command is the command to configure (Env, Dir, Stdout, ...) before
	// Start. Do not call its Start, Run, Output, CombinedOutput or Wait.
	Command *exec.Cmd

	ctx    context.Context
	exited chan struct{}
	err    error
}

// NewChild returns an unstarted child running name with arguments.
func NewChild(t testing.TB, name string, arguments ...string) *Child {
	t.Helper()

	ctx := t.Context()

	if deadline, ok := deadlineOf(t); ok {
		grace := min(time.Until(deadline)/10, maxChildGrace)

		var cancel context.CancelFunc

		ctx, cancel = context.WithDeadlineCause(ctx, deadline.Add(-grace), ErrTestDeadline)
		t.Cleanup(cancel)
	}

	command := exec.CommandContext(ctx, name, arguments...)
	command.WaitDelay = childWaitDelay
	configureChild(command)

	return &Child{Command: command, ctx: ctx, exited: make(chan struct{})}
}

func deadlineOf(t testing.TB) (time.Time, bool) {
	if withDeadline, ok := t.(interface{ Deadline() (time.Time, bool) }); ok {
		return withDeadline.Deadline()
	}

	return time.Time{}, false
}

// Start starts the child and returns once it runs. Cleanup kills the
// child's process group and waits for the child to exit.
func (process *Child) Start(t testing.TB) {
	t.Helper()

	started := make(chan error, 1)

	// On Linux the child gets Pdeathsig, which fires when the *thread* that
	// started it exits, not the test process. The Go runtime may retire a
	// thread, which would kill the child early. Starting it from a
	// goroutine locked to its thread, which waits for the child before it
	// returns, pins that thread for the child's whole lifetime. The
	// goroutine never unlocks, so the runtime discards the thread when the
	// goroutine returns, by which time the child has been reaped.
	go func() {
		runtime.LockOSThread()

		if err := process.Command.Start(); err != nil {
			started <- err

			return
		}

		started <- nil

		err := process.Command.Wait()
		if err != nil && errors.Is(context.Cause(process.ctx), ErrTestDeadline) {
			err = fmt.Errorf("%w: %w", ErrTestDeadline, err)
		}

		process.err = err
		close(process.exited)
	}()

	require.NoError(t, <-started)

	t.Cleanup(func() {
		// The group outlives its leader while descendants remain, so kill
		// it even if the child already exited.
		_ = killChildGroup(process.Command)

		<-process.exited
	})
}

// Exited is closed once the child has exited and its output is collected.
func (process *Child) Exited() <-chan struct{} {
	return process.exited
}

// Err returns the error from waiting for the child. It is valid only after
// Exited is closed.
func (process *Child) Err() error {
	return process.err
}

// Wait blocks until the child exits and returns the error from waiting for
// it.
func (process *Child) Wait() error {
	<-process.exited

	return process.err
}

// BuildServer builds cmd/vault-sync-server, with the given build tags, into a
// temporary directory and returns the binary's path. repoRoot is the
// repository root.
func BuildServer(t testing.TB, repoRoot string, tags ...string) string {
	t.Helper()

	binary := filepath.Join(t.TempDir(), "vault-sync-server")
	if runtime.GOOS == "windows" {
		// Windows only runs files with an executable extension.
		binary += ".exe"
	}

	arguments := []string{"build", "-o", binary}
	if len(tags) > 0 {
		arguments = append(arguments, "-tags", strings.Join(tags, ","))
	}

	build := exec.CommandContext(t.Context(), "go", append(arguments, "./cmd/vault-sync-server")...)
	build.Dir = repoRoot

	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	output, err := build.CombinedOutput()
	require.NoError(t, err, "go build: %s", output)

	return binary
}
