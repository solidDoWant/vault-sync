//go:build integration

package main_test

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const (
	// maxChildGrace caps how long before the test binary's deadline a
	// child's context ends.
	maxChildGrace = 5 * time.Second

	// childWaitDelay bounds how long waiting for a child blocks on output
	// pipes that a descendant still holds open after the child exited.
	childWaitDelay = 5 * time.Second
)

// errTestDeadline is the cause of a child's context ending because the test
// binary's -timeout is about to fire.
var errTestDeadline = errors.New("killed before `go test -timeout` fires")

// child is a child process of the test that, together with every descendant
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
type child struct {
	// Command is the command to configure (Env, Dir, Stdout, ...) before
	// Start. Do not call its Start, Run, Output, CombinedOutput or Wait.
	Command *exec.Cmd

	ctx    context.Context
	exited chan struct{}
	err    error
}

// newChild returns an unstarted child running name with arguments.
func newChild(t *testing.T, name string, arguments ...string) *child {
	t.Helper()

	ctx := t.Context()

	if deadline, ok := t.Deadline(); ok {
		grace := min(time.Until(deadline)/10, maxChildGrace)

		var cancel context.CancelFunc

		ctx, cancel = context.WithDeadlineCause(ctx, deadline.Add(-grace), errTestDeadline)
		t.Cleanup(cancel)
	}

	command := exec.CommandContext(ctx, name, arguments...)
	command.WaitDelay = childWaitDelay
	configureChild(command)

	return &child{Command: command, ctx: ctx, exited: make(chan struct{})}
}

// Start starts the child and returns once it runs. Cleanup kills the
// child's process group and waits for the child to exit.
func (process *child) Start(t *testing.T) {
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
		if err != nil && errors.Is(context.Cause(process.ctx), errTestDeadline) {
			err = fmt.Errorf("%w: %w", errTestDeadline, err)
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
func (process *child) Exited() <-chan struct{} {
	return process.exited
}

// Err returns the error from waiting for the child. It is valid only after
// Exited is closed.
func (process *child) Err() error {
	return process.err
}

// Wait blocks until the child exits and returns the error from waiting for
// it.
func (process *child) Wait() error {
	<-process.exited

	return process.err
}
