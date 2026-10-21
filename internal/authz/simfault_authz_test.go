//go:build !simfault_authz

package authz

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestDefaultBuildRefusesViewerWrites proves that a build without the
// `simfault_authz` tag, such as every release binary, refuses a viewer's
// writes: only the simulation harness's deliberately broken server accepts
// them.
func TestDefaultBuildRefusesViewerWrites(t *testing.T) {
	assert.False(t, acceptViewerWrites, "viewer writes must only be accepted in -tags simfault_authz builds")
}
