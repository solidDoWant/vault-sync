// Package vaultimport is the `vault-sync-server import` subcommand, which
// loads a folder of Markdown notes and attachments into an empty vault
// (engine.md §9). Every file becomes one document with a single revision
// and no history: TEXT for a `.md` file, BLOB for any other file, and
// FOLDER for an empty folder. A name outside the portable set (engine.md
// §6), a link, a file over the server's size limit or a name another file
// already takes is skipped and listed in the report; the rest still import.
package vaultimport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/solidDoWant/vault-sync/internal/pathkey"
	"github.com/solidDoWant/vault-sync/internal/vaultpath"
)

// Kind is an imported document's kind, as the store names it.
type Kind string

// Document kinds.
const (
	KindText   Kind = "text"
	KindBlob   Kind = "blob"
	KindFolder Kind = "folder"
)

// Entry is one document to create.
type Entry struct {
	// Path is the vault-relative NFC path, with "/" separators.
	Path string
	Kind Kind
	// Content is the file's bytes; nil for a folder.
	Content []byte
}

// Target creates the imported documents.
type Target interface {
	// Create creates one document. It returns a *SkipError when the
	// document cannot be created but the import may go on.
	Create(ctx context.Context, entry Entry) error
}

// SkipError is a document Target.Create refused, with the reason.
type SkipError struct {
	Reason string
}

func (err *SkipError) Error() string { return err.Reason }

// Skip is one file or folder the import left out.
type Skip struct {
	// Path is the vault-relative path as found on disk (not normalized).
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// Counts counts the imported documents by kind.
type Counts struct {
	Text   int `json:"text"`
	Blob   int `json:"blob"`
	Folder int `json:"folder"`
}

// Result is what an import did.
type Result struct {
	Imported Counts `json:"imported"`
	// Bytes is the total size of the imported files.
	Bytes   int64  `json:"bytes"`
	Skipped []Skip `json:"skipped"`
}

// Options configure Import.
type Options struct {
	// Source is the folder whose contents are imported.
	Source string
	// MaxFileBytes is the largest file imported.
	MaxFileBytes int64
	Target       Target
}

// Import creates one document per file and empty folder under
// options.Source. It returns an error only when the import cannot go on;
// everything it left out is in Result.Skipped.
func Import(ctx context.Context, options Options) (Result, error) {
	result := Result{Skipped: []Skip{}}

	info, err := os.Stat(options.Source)
	if err != nil {
		return result, fmt.Errorf("read the source folder: %w", err)
	}

	if !info.IsDir() {
		return result, fmt.Errorf("%s is not a folder", options.Source)
	}

	walker := walker{options: options, result: &result}

	return result, walker.folder(ctx, options.Source, "", "")
}

type walker struct {
	options Options
	result  *Result
}

func (walker *walker) skip(diskPath, reason string) {
	walker.result.Skipped = append(walker.result.Skipped, Skip{Path: diskPath, Reason: reason})
}

// folder imports the contents of directory, whose vault-relative path is
// diskPath as found on disk and vaultPath once normalized (both empty for
// the source folder itself).
func (walker *walker) folder(ctx context.Context, directory, diskPath, vaultPath string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return fmt.Errorf("read folder %s: %w", directory, err)
	}

	if len(entries) == 0 && vaultPath != "" {
		return walker.create(ctx, diskPath, Entry{Path: vaultPath, Kind: KindFolder})
	}

	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}

		childDisk := path.Join(diskPath, entry.Name())
		childFull := filepath.Join(directory, entry.Name())

		if !utf8.ValidString(entry.Name()) {
			walker.skip(childDisk, "unportable name: the name is not valid UTF-8")

			continue
		}

		name := pathkey.NFC(entry.Name())
		childVault := path.Join(vaultPath, name)

		if reason := checkPortable(childVault); reason != nil {
			if entry.IsDir() {
				walker.skip(childDisk, "unportable name: "+reason.Error()+"; nothing in the folder was imported")
			} else {
				walker.skip(childDisk, "unportable name: "+reason.Error())
			}

			continue
		}

		switch mode := entry.Type(); {
		case mode.IsDir():
			if err := walker.folder(ctx, childFull, childDisk, childVault); err != nil {
				return err
			}
		case mode.IsRegular():
			if err := walker.file(ctx, childFull, childDisk, childVault); err != nil {
				return err
			}
		case mode&os.ModeSymlink != 0:
			walker.skip(childDisk, "a symbolic link; links are not followed")
		default:
			walker.skip(childDisk, "not a regular file or folder")
		}
	}

	return nil
}

func (walker *walker) file(ctx context.Context, fullPath, diskPath, vaultPath string) error {
	content, tooLarge, err := readFile(fullPath, walker.options.MaxFileBytes)
	if err != nil {
		return err
	}

	if tooLarge {
		walker.skip(diskPath, fmt.Sprintf("larger than the server's file size limit of %d bytes", walker.options.MaxFileBytes))

		return nil
	}

	kind := KindBlob
	if strings.HasSuffix(vaultPath, ".md") {
		kind = KindText
	}

	return walker.create(ctx, diskPath, Entry{Path: vaultPath, Kind: kind, Content: content})
}

func (walker *walker) create(ctx context.Context, diskPath string, entry Entry) error {
	err := walker.options.Target.Create(ctx, entry)

	var skipped *SkipError

	switch {
	case errors.As(err, &skipped):
		walker.skip(diskPath, skipped.Reason)

		return nil
	case err != nil:
		return fmt.Errorf("import %s: %w", diskPath, err)
	}

	switch entry.Kind {
	case KindText:
		walker.result.Imported.Text++
	case KindBlob:
		walker.result.Imported.Blob++
	case KindFolder:
		walker.result.Imported.Folder++
	}

	walker.result.Bytes += int64(len(entry.Content))

	return nil
}

// checkPortable returns why path, a vault-relative NFC path whose folders
// already passed it, may not be given to a new document (engine.md §6), or
// nil. It is the rule CommitRevision applies to a new path.
func checkPortable(path string) error {
	if err := vaultpath.CheckText(path); err != nil {
		return err
	}

	return vaultpath.CheckNew(path)
}

// readFile reads the file at fullPath, unless it holds more than limit
// bytes.
func readFile(fullPath string, limit int64) (content []byte, tooLarge bool, err error) {
	file, err := os.Open(fullPath)
	if err != nil {
		return nil, false, fmt.Errorf("open %s: %w", fullPath, err)
	}
	defer func() { _ = file.Close() }()

	info, err := file.Stat()
	if err != nil {
		return nil, false, fmt.Errorf("stat %s: %w", fullPath, err)
	}

	if info.Size() > limit {
		return nil, true, nil
	}

	content, err = io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, false, fmt.Errorf("read %s: %w", fullPath, err)
	}

	if int64(len(content)) > limit {
		return nil, true, nil
	}

	if content == nil {
		content = []byte{}
	}

	return content, false, nil
}
