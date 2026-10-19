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
// document into: it must also contain no "\" (decision, #191). Windows
// reads "\" as a separator and other platforms as part of a name, so "a/b"
// and "a\b" would otherwise be two live documents naming one file on
// Windows. Documents committed before the rule keep their "\" paths, which
// still pass Check.
//
// The TypeScript client (plugin/src/core/vaultpath) applies the same rules,
// and testdata/paths/validity.json is the shared conformance suite.
package vaultpath

import (
	"errors"
	"strings"
)

// ErrNotRelative is returned for a path that is not vault-relative.
var ErrNotRelative = errors.New(`path must be relative ("/" and "\" are both separators), ` +
	`with no drive letter and no empty, "." or ".." segments`)

// ErrBackslash is returned by CheckNew for a vault-relative path that
// contains "\".
var ErrBackslash = errors.New(`a new path must not contain "\"; use "/" as the separator`)

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

// CheckNew returns ErrNotRelative unless path is vault-relative, and
// ErrBackslash if it is but contains "\": a commit may create or rename a
// document only into a path that passes CheckNew.
func CheckNew(path string) error {
	if err := Check(path); err != nil {
		return err
	}

	if strings.Contains(path, `\`) {
		return ErrBackslash
	}

	return nil
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
