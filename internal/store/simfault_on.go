//go:build simfault

package store

// A deliberately broken build for the simulation harness's self-test
// (sim/simulation_test.go): CommitRevision accepts any base revision. Never
// build a release with the `simfault` tag.
const skipBaseRevisionCheck = true
