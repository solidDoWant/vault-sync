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
	"unicode/utf8"

	"github.com/google/uuid"

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
	errPathNotUTF8     = errors.New("path is not valid UTF-8")
	errContentLength   = errors.New("stored content does not have the blob's size")
	errContentHash     = errors.New("stored content does not match its blob id")
	errContentMissing  = errors.New("stored content is missing")
)

// documentError is a problem confined to one document. A problem with its
// path puts the document in the unplaced tree instead of the vault tree; a
// problem with its content leaves its bytes out of the export. Either way
// the export continues.
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

// remove removes the file at path after its content failed, and the
// directories left empty by its removal.
func (tree *vaultTree) remove(path string) error {
	if err := tree.root.Remove(path); err != nil {
		return fmt.Errorf("remove file: %w", withoutPath(err))
	}

	return tree.prune(path)
}

// prune removes the directories on path that are empty, deepest first, so a
// refused document leaves no directory without a document in it. Only
// directories the tree created or checked are considered, and removing one
// never removes anything in it: the first that is not empty stops pruning.
func (tree *vaultTree) prune(path string) error {
	segments := strings.Split(path, "/")
	for index := len(segments) - 1; index > 0; index-- {
		dir := strings.Join(segments[:index], "/")
		if !tree.dirs[dir] {
			continue
		}

		err := tree.root.Remove(dir)
		if errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, fs.ErrExist) {
			return nil
		}

		if err != nil {
			return fmt.Errorf("remove empty directory: %w", withoutPath(err))
		}

		delete(tree.dirs, dir)
	}

	return nil
}

// unplacedTree holds a vault's documents that cannot be placed at their
// path, each in a file named by its document id. The directory is created
// when the first such document is written. Its names are chosen by the
// export, never by users, so they can never conflict.
type unplacedTree struct {
	directory string
	root      *os.Root
	// files counts the files in the directory.
	files int
}

// create creates the empty file for the document. Any error is a failure of
// the export itself: there is nowhere else to keep the document.
func (tree *unplacedTree) create(id uuid.UUID) (*os.File, error) {
	if tree.root == nil {
		if err := os.Mkdir(tree.directory, dirMode); err != nil {
			return nil, fmt.Errorf("create unplaced directory: %w", withoutPath(err))
		}

		root, err := os.OpenRoot(tree.directory)
		if err != nil {
			return nil, fmt.Errorf("open unplaced directory: %w", withoutPath(err))
		}

		tree.root = root
	}

	file, err := tree.root.OpenFile(id.String(), os.O_WRONLY|os.O_CREATE|os.O_EXCL, fileMode)
	if err != nil {
		return nil, fmt.Errorf("create unplaced file: %w", withoutPath(err))
	}

	tree.files++

	return file, nil
}

// remove removes the document's file after its content failed, and the
// directory if that was its only file, so the directory exists only when it
// holds a document.
func (tree *unplacedTree) remove(id uuid.UUID) error {
	if err := tree.root.Remove(id.String()); err != nil {
		return fmt.Errorf("remove unplaced file: %w", withoutPath(err))
	}

	tree.files--
	if tree.files > 0 {
		return nil
	}

	err := tree.root.Close()
	tree.root = nil

	if err != nil {
		return fmt.Errorf("close unplaced directory: %w", withoutPath(err))
	}

	if err := os.Remove(tree.directory); err != nil {
		return fmt.Errorf("remove empty unplaced directory: %w", withoutPath(err))
	}

	return nil
}

func (tree *unplacedTree) Close() error {
	if tree.root == nil {
		return nil
	}

	return tree.root.Close()
}

// writeContent fills file with the content open returns, which must be
// exactly size bytes whose SHA-256 is sum, and closes it. open is called
// only once the file has been created. It returns a *documentError for
// missing or wrong content, and any other error for a failure of the export
// itself. The caller removes the file after an error.
func writeContent(file *os.File, open func() (io.ReadCloser, error), size int64, sum []byte) error {
	err := fill(file, open, size, sum)
	if closeErr := file.Close(); err == nil && closeErr != nil {
		err = fmt.Errorf("write file: %w", withoutPath(closeErr))
	}

	return err
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

	// The manifest is JSON, which carries only UTF-8: a file whose name is
	// not UTF-8 could not be named exactly in it.
	if !utf8.ValidString(path) {
		return nil, refuse(errPathNotUTF8)
	}

	file, err := tree.createFile(path)

	var refused *documentError
	if errors.As(err, &refused) {
		// The document goes elsewhere: drop the directories made for it.
		if err := tree.prune(path); err != nil {
			return nil, err
		}
	}

	return file, err
}

// createFile creates path's directories and an empty file.
func (tree *vaultTree) createFile(path string) (*os.File, error) {
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
