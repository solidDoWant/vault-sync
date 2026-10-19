//go:build simfault_retry

package store

// A deliberately broken build for the simulation harness's self-test
// (sim/simulation_test.go): CommitRevision refuses a retry of a revision it
// already applied once the document's head has moved past it, the #12 bug.
// Never build a release with the `simfault_retry` tag.
const refuseAppliedRetryAfterHeadMoved = true
