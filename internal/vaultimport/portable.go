package vaultimport

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Portable-name bounds (engine.md §6).
const (
	// maxNameBytes bounds one path component.
	maxNameBytes = 255
	// maxPathBytes bounds the whole vault-relative path.
	maxPathBytes = 1024
)

// forbiddenCharacters may not appear in a portable name (engine.md §6).
const forbiddenCharacters = `<>:"/\|?*`

// reservedNames are the Windows device names, which are reserved with or
// without an extension (engine.md §6).
var reservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
	"COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
	"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// checkName returns why name, one NFC path component, is not a portable
// name (engine.md §6), or nil.
func checkName(name string) error {
	switch {
	case !utf8.ValidString(name):
		return fmt.Errorf("the name is not valid UTF-8")
	case name == "." || name == "..":
		return fmt.Errorf("the name is %q", name)
	case len(name) > maxNameBytes:
		return fmt.Errorf("the name is longer than %d UTF-8 bytes", maxNameBytes)
	case strings.HasPrefix(name, " ") || strings.HasSuffix(name, " "):
		return fmt.Errorf("the name starts or ends with a space")
	case strings.HasSuffix(name, "."):
		return fmt.Errorf("the name ends with %q", ".")
	}

	for _, character := range name {
		if strings.ContainsRune(forbiddenCharacters, character) {
			return fmt.Errorf("the name contains %q", character)
		}

		if unicode.IsControl(character) {
			return fmt.Errorf("the name contains the control character %U", character)
		}
	}

	base, _, _ := strings.Cut(name, ".")
	if reservedNames[strings.ToUpper(base)] {
		return fmt.Errorf("%q is a reserved name on Windows", base)
	}

	return nil
}

// checkPath returns why path, a vault-relative NFC path with "/"
// separators, is too long to be portable (engine.md §6), or nil. Its
// components are checked by checkName.
func checkPath(path string) error {
	if len(path) > maxPathBytes {
		return fmt.Errorf("the path is longer than %d UTF-8 bytes", maxPathBytes)
	}

	return nil
}
