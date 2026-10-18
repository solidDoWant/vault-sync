//go:build !simfault

package store

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestDefaultBuildChecksBaseRevision proves that a build without the
// `simfault` tag, such as every release binary, keeps CommitRevision's
// base-revision check: only the simulation harness's deliberately broken
// server skips it.
func TestDefaultBuildChecksBaseRevision(t *testing.T) {
	assert.False(t, skipBaseRevisionCheck, "the base-revision check must only be skipped in -tags simfault builds")
}
