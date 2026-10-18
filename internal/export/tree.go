package export

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"syscall"

	"github.com/solidDoWant/vault-sync/internal/vaultpath"
)

// Permissions of exported directories and files: readable by the owner's
// group (for example a backup tool's), never by others.
const (
	dirMode  fs.FileMode = 0o750
	fileMode fs.FileMode = 0o640
)

// Reasons a document is refused. They name the problem without the path,
// which is user data.
var (
	errPathNotRelative = errors.New("path is not vault-relative")
	errPathConflict    = errors.New("path conflicts with another document's file or directory")
	errPathSymlink     = errors.New("path crosses a symbolic link")
	errPathUnwritable  = errors.New("path cannot be created on this filesystem")
	errContentLength   = errors.New("stored content does not have the blob's size")
	errContentHash     = errors.New("stored content does not match its blob id")
	errContentMissing  = errors.New("stored content is missing")
)

// documentError is a problem confined to one document: the document is left
// out of the export, which continues.
type documentError struct {
	reason error
}

func (err *documentError) Error() string { return err.reason.Error() }

func (err *documentError) Unwrap() error { return err.reason }

func refuse(reason error) error { return &documentError{reason: reason} }

// vaultTree writes one vault's documents under its directory. Every write
// goes through an os.Root opened on that directory, so no path can resolve
// outside it, and every directory on a document's path is checked with Lstat
// before use, so a symbolic link is refused rather than followed.
type vaultTree struct {
	root *os.Root
	// dirs are the directories (slash-separated, relative to the root)
	// already created or checked.
	dirs map[string]bool
}

func openVaultTree(directory string) (*vaultTree, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, fmt.Errorf("open vault directory: %w", err)
	}

	return &vaultTree{root: root, dirs: map[string]bool{}}, nil
}

func (tree *vaultTree) Close() error {
	return tree.root.Close()
}

// write creates the file at the vault-relative path and fills it with the
// content open returns, which must be exactly size bytes whose SHA-256 is
// sum. open is called only once the path has been checked and the file
// created. write returns a *documentError for a problem with this document
// alone (the file is then not left behind), and any other error for a
// failure of the export itself.
func (tree *vaultTree) write(path string, open func() (io.ReadCloser, error), size int64, sum []byte) error {
	file, err := tree.create(path)
	if err != nil {
		return err
	}

	err = fill(file, open, size, sum)
	if closeErr := file.Close(); err == nil && closeErr != nil {
		err = fmt.Errorf("write file: %w", withoutPath(closeErr))
	}

	if err != nil {
		_ = tree.root.Remove(path)

		return err
	}

	return nil
}

// create checks path and creates its directories and an empty file.
func (tree *vaultTree) create(path string) (*os.File, error) {
	// The shared rule (SPEC.md §6.2) treats "\" as a separator too, so
	// a path that passes it has no "..", "." or empty segment between any
	// separators. On this platform only "/" separates; "\" is an ordinary
	// character of a name.
	if err := vaultpath.Check(path); err != nil {
		return nil, refuse(errPathNotRelative)
	}

	segments := strings.Split(path, "/")
	for index := 1; index < len(segments); index++ {
		if err := tree.mkdir(strings.Join(segments[:index], "/")); err != nil {
			return nil, err
		}
	}

	// O_EXCL never follows a symbolic link and fails on any existing
	// entry, so a file is never overwritten or written through a link.
	file, err := tree.root.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fileMode)
	if err != nil {
		return nil, pathError(err)
	}

	return file, nil
}

func fill(file io.Writer, open func() (io.ReadCloser, error), size int64, sum []byte) error {
	content, err := open()
	if err != nil {
		return err
	}

	defer func() { _ = content.Close() }()

	return copyVerified(file, content, size, sum)
}

// mkdir ensures dir is a real directory, creating it if needed.
func (tree *vaultTree) mkdir(dir string) error {
	if tree.dirs[dir] {
		return nil
	}

	err := tree.root.Mkdir(dir, dirMode)
	if err != nil && !errors.Is(err, fs.ErrExist) {
		return pathError(err)
	}

	if err != nil {
		info, err := tree.root.Lstat(dir)
		if err != nil {
			return pathError(err)
		}

		switch {
		case info.Mode()&fs.ModeSymlink != 0:
			return refuse(errPathSymlink)
		case !info.IsDir():
			return refuse(errPathConflict)
		}
	}

	tree.dirs[dir] = true

	return nil
}

// pathError classifies a filesystem error on a document's path.
func pathError(err error) error {
	switch {
	case errors.Is(err, fs.ErrExist), errors.Is(err, syscall.ENOTDIR), errors.Is(err, syscall.EISDIR):
		return refuse(errPathConflict)
	case errors.Is(err, syscall.ELOOP):
		return refuse(errPathSymlink)
	case errors.Is(err, syscall.ENAMETOOLONG), errors.Is(err, syscall.EINVAL), errors.Is(err, syscall.EILSEQ):
		return refuse(errPathUnwritable)
	default:
		// Including os.Root refusing a path that resolves outside the
		// vault directory, which only a link created during the export
		// (every directory was checked) can cause.
		return fmt.Errorf("create file: %w", withoutPath(err))
	}
}

// withoutPath strips the file name from a filesystem error: errors end up
// in logs and the summary, and document paths are user data.
func withoutPath(err error) error {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return fmt.Errorf("%s: %w", pathErr.Op, pathErr.Err)
	}

	return err
}

// copyVerified copies exactly size bytes from content to file and checks
// their SHA-256 against sum, streaming through a fixed buffer.
func copyVerified(file io.Writer, content io.Reader, size int64, sum []byte) error {
	hash := sha256.New()

	// One byte more than expected reveals an over-long object.
	written, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(contentReader{reader: content}, size+1))

	var readErr *readError

	switch {
	case errors.As(err, &readErr):
		return readErr.err
	case err != nil:
		return fmt.Errorf("write file: %w", withoutPath(err))
	case written != size:
		return refuse(errContentLength)
	case !bytes.Equal(hash.Sum(nil), sum):
		return refuse(errContentHash)
	default:
		return nil
	}
}

// readError marks an error from the content reader, to tell it apart from a
// write error in io.Copy.
type readError struct {
	err error
}

func (err *readError) Error() string { return err.err.Error() }

// contentReader wraps a reader so its errors are reported as *readError.
type contentReader struct {
	reader io.Reader
}

func (reader contentReader) Read(buffer []byte) (int, error) {
	count, err := reader.reader.Read(buffer)
	if err != nil && !errors.Is(err, io.EOF) {
		return count, &readError{err: fmt.Errorf("read content: %w", err)}
	}

	return count, err
}
