//go:build simfault_authz

package authz

// A deliberately broken build for the simulation harness's self-test
// (sim/simulation_test.go): viewers may write. Never build a release with
// the `simfault_authz` tag.
const acceptViewerWrites = true
