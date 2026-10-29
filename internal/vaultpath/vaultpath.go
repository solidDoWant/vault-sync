// Package vaultpath checks that a plaintext path is vault-relative on every
// supported client platform (SPEC.md §6.2).
//
// Windows treats "\" as a separator as well as "/", a leading drive letter
// ("C:", "C:x", "C:\x") or separator ("\x", UNC "\\server\share", "\\?\",
// "\\.\") as rooting the path elsewhere, and strips trailing dots and spaces
// from each segment, so ".. " or "..." resolve like ".." or ".". A path that
// passes Check stays inside the vault directory on every platform. Names
// that are merely unmaterializable on Windows (reserved device names,
// colons elsewhere, trailing dots or spaces on other names) pass: refusing
// them is the client's job, not a security boundary.
//
// CheckNew is the stricter rule for a path a commit creates or renames a
// document into. It must also contain no "\" (decision, #191). Windows
// reads "\" as a separator and other platforms as part of a name, so "a/b"
// and "a\b" would otherwise be two live documents naming one file on
// Windows. It must also not start with any single code point and a colon
// (decision, #148): Win32 reads any first character followed by ":" as a
// drive, and drives such as "1:" can be created with subst. And it must be
// portable (docs/design/engine.md §6): no part contains any of <>:"|?*,
// starts or ends with a space, ends in a dot or is a Windows reserved name
// (CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9, in any case, with or
// without an extension); no part is longer than MaxNameBytes; and the
// whole path is at most MaxNewBytes. Every code point must be assigned in
// Unicode 15.0 (pathkey.Assigned, docs/design/engine.md §6), whose
// normalization and case folding the Go and JavaScript libraries agree on.
// And it must be in Unicode NFC (docs/design/engine.md §6): Obsidian stores
// every path in NFC, so another spelling could never match a file on a
// device. Documents committed before these rules keep their
// paths, which still pass Check.
//
// CheckText is the length and character-set rule every plaintext path must
// also pass.
//
// The TypeScript client (plugin/src/core/vaultpath) applies the same rules.
// testdata/paths/validity.json (Check, CheckNew) and testdata/paths/text.json
// (CheckText) are the shared conformance suites.
package vaultpath

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/solidDoWant/vault-sync/internal/pathkey"
	"github.com/solidDoWant/vault-sync/internal/textcheck"
)

// MaxBytes bounds a plaintext path (UTF-8 bytes).
const MaxBytes = 4096

// ErrNotRelative is returned for a path that is not vault-relative.
var ErrNotRelative = errors.New(`path must be relative ("/" and "\" are both separators), ` +
	`with no drive letter and no empty, "." or ".." segments`)

// ErrNotNew is wrapped by every error CheckNew returns for a path that is
// vault-relative but may no longer be given to a document: a commit may
// keep it only as a live document's unchanged path.
var ErrNotNew = errors.New("a new path may not be created at this path")

// ErrBackslash is returned by CheckNew for a vault-relative path that
// contains "\". It wraps ErrNotNew.
var ErrBackslash = fmt.Errorf(`%w: a new path must not contain "\"; use "/" as the separator`, ErrNotNew)

// ErrDrivePrefix is returned by CheckNew for a vault-relative path that
// starts with one code point and a colon, such as "1:x". It wraps
// ErrNotNew.
var ErrDrivePrefix = fmt.Errorf(`%w: a new path must not start with one character and ":", which Windows reads as a drive`, ErrNotNew)

// MaxNameBytes bounds each part of a path CheckNew accepts (UTF-8 bytes).
const MaxNameBytes = 255

// MaxNewBytes bounds a path CheckNew accepts (UTF-8 bytes).
const MaxNewBytes = 1024

// ErrForbiddenCharacter is returned by CheckNew for a path with any of
// <>:"|?* in a part. It wraps ErrNotNew.
var ErrForbiddenCharacter = fmt.Errorf(`%w: a new path must not contain any of < > : " | ? *`, ErrNotNew)

// ErrEdgeSpace is returned by CheckNew for a path with a part that starts or
// ends with a space. It wraps ErrNotNew.
var ErrEdgeSpace = fmt.Errorf("%w: a file or folder name in a new path must not start or end with a space", ErrNotNew)

// ErrTrailingDot is returned by CheckNew for a path with a part that ends in
// a dot. It wraps ErrNotNew.
var ErrTrailingDot = fmt.Errorf("%w: a file or folder name in a new path must not end in a dot", ErrNotNew)

// ErrReservedName is returned by CheckNew for a path with a part that is a
// Windows reserved name, with or without an extension. It wraps ErrNotNew.
var ErrReservedName = fmt.Errorf("%w: a file or folder name in a new path must not be a Windows reserved name "+
	"(CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9), with or without an extension", ErrNotNew)

// ErrNameTooLong is returned by CheckNew for a path with a part longer than
// MaxNameBytes. It wraps ErrNotNew.
var ErrNameTooLong = fmt.Errorf("%w: a file or folder name in a new path must be at most %d bytes", ErrNotNew, MaxNameBytes)

// ErrNewTooLong is returned by CheckNew for a path longer than MaxNewBytes.
// It wraps ErrNotNew.
var ErrNewTooLong = fmt.Errorf("%w: a new path must be at most %d bytes", ErrNotNew, MaxNewBytes)

// ErrUnassigned is returned by CheckNew for a path with a code point not
// assigned in Unicode 15.0 (pathkey.Assigned). It wraps ErrNotNew.
var ErrUnassigned = fmt.Errorf("%w: a new path may only use characters assigned in Unicode 15.0", ErrNotNew)

// ErrNotNFC is returned by CheckNew for a path that is not in Unicode NFC.
// It wraps ErrNotNew.
var ErrNotNFC = fmt.Errorf("%w: a new path must be in Unicode NFC (composed characters, as Obsidian stores them)", ErrNotNew)

// ErrLength is returned by CheckText for an empty path or one longer than
// MaxBytes.
var ErrLength = fmt.Errorf("path must be 1 to %d bytes", MaxBytes)

// ErrNotPrintable is returned by CheckText for a path that is not valid
// UTF-8 or contains a control character.
var ErrNotPrintable = errors.New("path must be valid UTF-8 without control characters")

// CheckText returns ErrLength unless path is 1 to MaxBytes bytes, and
// ErrNotPrintable unless it is valid UTF-8 without control characters
// (textcheck.Printable).
func CheckText(path string) error {
	if len(path) == 0 || len(path) > MaxBytes {
		return ErrLength
	}

	if !textcheck.Printable(path) {
		return ErrNotPrintable
	}

	return nil
}

// separators are the path separators on any supported platform.
const separators = `/\`

// Check returns ErrNotRelative unless path is vault-relative. Length and
// character-set limits are checked separately.
func Check(path string) error {
	if hasDrivePrefix(path) {
		return ErrNotRelative
	}

	// A leading, trailing or doubled separator (including UNC and \\?\
	// prefixes) yields an empty segment.
	for {
		end := strings.IndexAny(path, separators)
		if end < 0 {
			return checkSegment(path)
		}

		if err := checkSegment(path[:end]); err != nil {
			return err
		}

		path = path[end+1:]
	}
}

// CheckNew returns ErrNotRelative unless path is vault-relative, and an
// error wrapping ErrNotNew if it is but breaks a new-path rule: ErrBackslash,
// ErrDrivePrefix, ErrForbiddenCharacter, ErrEdgeSpace, ErrTrailingDot,
// ErrReservedName, ErrNameTooLong, ErrNewTooLong, ErrUnassigned or ErrNotNFC. A commit may create or
// rename a document only into a path that passes CheckNew.
func CheckNew(path string) error {
	if err := Check(path); err != nil {
		return err
	}

	if strings.Contains(path, `\`) {
		return ErrBackslash
	}

	if _, size := utf8.DecodeRuneInString(path); strings.HasPrefix(path[size:], ":") {
		return ErrDrivePrefix
	}

	for name := range strings.SplitSeq(path, "/") {
		if err := checkPortableName(name); err != nil {
			return err
		}
	}

	if len(path) > MaxNewBytes {
		return ErrNewTooLong
	}

	if !pathkey.Assigned(path) {
		return ErrUnassigned
	}

	if pathkey.NFC(path) != path {
		return ErrNotNFC
	}

	return nil
}

// checkPortableName applies the new-path rules to one part of a path.
func checkPortableName(name string) error {
	switch {
	case strings.ContainsAny(name, `<>:"|?*`):
		return ErrForbiddenCharacter
	case strings.HasPrefix(name, " ") || strings.HasSuffix(name, " "):
		return ErrEdgeSpace
	case strings.HasSuffix(name, "."):
		return ErrTrailingDot
	case isReservedName(name):
		return ErrReservedName
	case len(name) > MaxNameBytes:
		return ErrNameTooLong
	default:
		return nil
	}
}

// isReservedName reports whether name, up to its first dot, is a Windows
// reserved device name in any case.
func isReservedName(name string) bool {
	base, _, _ := strings.Cut(name, ".")

	switch strings.ToUpper(base) {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}

	if len(base) != 4 || base[3] < '1' || base[3] > '9' {
		return false
	}

	prefix := strings.ToUpper(base[:3])

	return prefix == "COM" || prefix == "LPT"
}

// checkSegment rejects a segment that is empty, ".", "..", or a form Windows
// reduces to one of them by stripping trailing dots and spaces.
func checkSegment(segment string) error {
	if strings.Trim(segment, ". ") == "" {
		return ErrNotRelative
	}

	return nil
}

// hasDrivePrefix reports whether path starts with an ASCII letter and a
// colon, which Windows resolves against that drive rather than the vault.
func hasDrivePrefix(path string) bool {
	if len(path) < 2 || path[1] != ':' {
		return false
	}

	letter := path[0] | 0x20 // ASCII lower-case

	return letter >= 'a' && letter <= 'z'
}
