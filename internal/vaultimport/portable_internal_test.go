package vaultimport

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Linux filesystems hold names of at most 255 bytes, so the name bound is
// tested on checkName rather than through files on disk.
func TestCheckNameBoundsANameAt255Bytes(t *testing.T) {
	fits := strings.Repeat("é", 125) + "ab.md"
	tooLong := strings.Repeat("é", 126) + "a.md"

	require.Len(t, fits, 255)
	require.Len(t, tooLong, 256)

	require.NoError(t, checkName(fits))

	err := checkName(tooLong)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "longer than 255 UTF-8 bytes")
}
