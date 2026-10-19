//go:build !simfault_retry

package store

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestDefaultBuildReturnsAppliedRetries proves that a build without the
// `simfault_retry` tag, such as every release binary, returns an applied
// revision to its retry however far the head moved: only the simulation
// harness's deliberately broken server refuses it.
func TestDefaultBuildReturnsAppliedRetries(t *testing.T) {
	assert.False(t, refuseAppliedRetryAfterHeadMoved, "applied retries must only be refused in -tags simfault_retry builds")
}
