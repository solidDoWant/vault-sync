//go:build !simfault

package store

// skipBaseRevisionCheck disables CommitRevision's optimistic-concurrency check
// so the simulation harness can prove it detects a server that accepts commits
// against a stale base (SPEC.md §13). It is true only in binaries built with
// the `simfault` build tag (simfault_on.go), which nothing but the simulation
// driver uses; there is deliberately no flag or environment variable for it.
const skipBaseRevisionCheck = false
