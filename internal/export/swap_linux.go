//go:build linux

package export

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// errLocked is returned when another export holds the lock.
var errLocked = errors.New("another export to this directory is running")

// lock takes an exclusive, non-blocking lock on the file at path, creating
// it if needed. The lock is held until the returned file is closed (or the
// process exits).
func lock(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}

	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()

		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, errLocked
		}

		return nil, fmt.Errorf("lock %s: %w", path, err)
	}

	return file, nil
}

// exchange atomically swaps the directories at a and b (renameat2 with
// RENAME_EXCHANGE): at every instant, each path names one complete tree.
func exchange(a, b string) error {
	if err := unix.Renameat2(unix.AT_FDCWD, a, unix.AT_FDCWD, b, unix.RENAME_EXCHANGE); err != nil {
		return fmt.Errorf("swap %s into place: %w", a, err)
	}

	return nil
}

// syncFilesystem flushes the filesystem holding directory to stable
// storage, so a tree swapped into place survives a power loss intact.
func syncFilesystem(directory string) error {
	dir, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open %s: %w", directory, err)
	}

	defer func() { _ = dir.Close() }()

	if err := unix.Syncfs(int(dir.Fd())); err != nil {
		return fmt.Errorf("sync filesystem: %w", err)
	}

	return nil
}
