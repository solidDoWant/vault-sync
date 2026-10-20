//go:build linux

package export

import "testing"

// SetSyncAfterSwapForTest replaces how the output directory's parent is
// synced after the swap, until the test ends.
func SetSyncAfterSwapForTest(t *testing.T, sync func(directory string) error) {
	t.Helper()

	previous := syncAfterSwap
	syncAfterSwap = sync

	t.Cleanup(func() { syncAfterSwap = previous })
}

// SetStagingSuffixForTest replaces the random number source of staging
// directory names, until the test ends.
func SetStagingSuffixForTest(t *testing.T, suffix func() uint32) {
	t.Helper()

	previous := stagingSuffix
	stagingSuffix = suffix

	t.Cleanup(func() { stagingSuffix = previous })
}
