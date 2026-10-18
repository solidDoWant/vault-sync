//go:build !linux

package export

import (
	"errors"
	"os"
)

// errUnsupported is returned on platforms without an atomic directory swap.
var errUnsupported = errors.New("export requires Linux, for its atomic directory swap (renameat2 RENAME_EXCHANGE)")

var errLocked = errors.New("another export to this directory is running")

func lock(string) (*os.File, error) { return nil, errUnsupported }

func exchange(string, string) error { return errUnsupported }

func syncFilesystem(string) error { return errUnsupported }
