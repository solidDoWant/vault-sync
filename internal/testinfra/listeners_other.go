//go:build !linux

package testinfra

// listensOn cannot tell outside Linux which process listens on a port, so
// it trusts that the server answering /readyz is the one started.
func listensOn(int, string) bool { return true }
