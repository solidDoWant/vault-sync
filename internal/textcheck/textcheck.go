// Package textcheck validates untrusted strings before they are stored or
// displayed.
package textcheck

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Printable reports whether s is valid UTF-8 and contains no control
// character (Unicode category Cc: U+0000–U+001F and U+007F–U+009F).
// PostgreSQL text cannot hold U+0000, and no control character belongs in an
// identifier or display name.
func Printable(s string) bool {
	return utf8.ValidString(s) && !strings.ContainsFunc(s, unicode.IsControl)
}
