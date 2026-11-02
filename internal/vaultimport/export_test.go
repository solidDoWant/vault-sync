package vaultimport

import (
	"testing"
	"time"
)

// SetRetryDelayForTest sets the wait before a restore's first retry for
// the duration of the test.
func SetRetryDelayForTest(t *testing.T, delay time.Duration) {
	t.Helper()

	previous := retryDelay
	retryDelay = delay

	t.Cleanup(func() { retryDelay = previous })
}
