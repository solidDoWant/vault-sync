//go:build !linux

package testinfra

import "os/exec"

// configureChild keeps exec's defaults: outside Linux the child is killed
// alone, and nothing kills it if the test binary dies first.
func configureChild(*exec.Cmd) {}

// killChildGroup kills the child.
func killChildGroup(command *exec.Cmd) error {
	return command.Process.Kill()
}
