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
// process exits). A symbolic link at path is refused, never followed, so a
// link planted beside the output cannot make the export create or lock a
// file elsewhere. So is anything but a regular file with one link owned by
// the running user, such as a hard link to another file or a FIFO (opened
// non-blocking, so it cannot stall the run).
func lock(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0o600)
	if errors.Is(err, unix.ELOOP) {
		return nil, fmt.Errorf("open lock file: %s is a symbolic link; remove it", path)
	}

	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}

	if err := checkLockFile(file, path); err != nil {
		_ = file.Close()

		return nil, err
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

// checkLockFile refuses an opened lock file that is not a regular file with
// exactly one link, owned by the running user.
func checkLockFile(file *os.File, path string) error {
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		return fmt.Errorf("inspect lock file %s: %w", path, err)
	}

	switch {
	case stat.Mode&unix.S_IFMT != unix.S_IFREG:
		return fmt.Errorf("lock file %s is not a regular file; remove it", path)
	case stat.Nlink != 1:
		return fmt.Errorf("lock file %s has %d hard links; remove it", path, stat.Nlink)
	case stat.Uid != uint32(os.Geteuid()):
		return fmt.Errorf("lock file %s is owned by uid %d, not by the user running the export (uid %d); remove it", path, stat.Uid, os.Geteuid())
	}

	return nil
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
