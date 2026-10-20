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

// DisplayName reports whether s is Printable and also contains no format
// character (Unicode category Cf: bidi embeddings, overrides, isolates and
// marks, zero-width spaces and joiners, the byte order mark, tag characters)
// and no line or paragraph separator (Zl, Zp). Names one user chooses and
// other users see must not hide text or reorder the label around them.
func DisplayName(s string) bool {
	return Printable(s) && !strings.ContainsFunc(s, invisible)
}

func invisible(r rune) bool {
	return unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp)
}
