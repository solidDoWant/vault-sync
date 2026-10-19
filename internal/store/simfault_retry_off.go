//go:build !simfault_retry

package store

// refuseAppliedRetryAfterHeadMoved makes CommitRevision answer a retry of a
// revision it already applied with FAILED_PRECONDITION once the document's
// head has moved past it, so the simulation harness can prove it detects the
// client-side duplicate that follows (#12, #110). It is true only in
// binaries built with the `simfault_retry` build tag (simfault_retry_on.go),
// which nothing but the simulation driver uses; there is deliberately no
// flag or environment variable for it.
const refuseAppliedRetryAfterHeadMoved = false
