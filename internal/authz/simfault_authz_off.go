//go:build !simfault_authz

package authz

// acceptViewerWrites lets a viewer call write procedures, so the simulation
// harness can prove it detects a server that accepts a demoted member's
// commits (#35). It is true only in binaries built with the `simfault_authz`
// build tag (simfault_authz_on.go), which nothing but the simulation driver
// uses; there is deliberately no flag or environment variable for it.
const acceptViewerWrites = false
