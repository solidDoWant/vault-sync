//go:build integration

package main_test

import (
	"os/exec"
	"syscall"
)

// configureChild puts the child in its own process group, so killChildGroup
// reaches its descendants, kills that group when the command's context ends,
// and has the kernel SIGKILL the child if the test binary dies first.
func configureChild(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:   true,
		Pdeathsig: syscall.SIGKILL,
	}
	command.Cancel = func() error { return killChildGroup(command) }
}

// killChildGroup kills the process group the child leads.
func killChildGroup(command *exec.Cmd) error {
	return syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
}
