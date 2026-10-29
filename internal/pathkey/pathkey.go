// Package pathkey derives the normalized path_key used to enforce per-vault
// path uniqueness (SPEC.md §5).
//
// A path_key is NFC(toCasefold(NFD(path))): Unicode canonical caseless
// matching (Unicode §3.13, D145) with full, locale-independent case folding
// (CaseFolding.txt statuses C and F, never T), emitted in NFC, with the NTFS
// upcase mapping on top (docs/design/engine.md §6): a code point whose
// simple uppercase folds differently from it folds as that uppercase does,
// so the dotless ı and I share a key. Two paths that would collide on a
// case-insensitive, normalization-insensitive filesystem get the same key.
// Nothing else is altered: separators, whitespace and dots are preserved,
// and no validation is performed.
//
// Normalization is golang.org/x/text/unicode/norm and case folding
// golang.org/x/text/cases. New names may only use code points assigned in
// Unicode 15.0 (internal/vaultpath), whose normalization and case folding
// Unicode keeps stable, so the TypeScript client (plugin/src/core/pathkey),
// which uses the runtime's String.prototype.normalize and a case-folding
// package, computes the same key. testdata/paths/vectors.json is the shared
// conformance suite.
package pathkey

import (
	"strings"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// NFC returns the canonical composition (NFC) of text. Invalid UTF-8 bytes
// become U+FFFD. Other packages that need the same normalization as the
// TypeScript client (internal/e2ee for passphrases) use it.
func NFC(text string) string {
	return norm.NFC.String(validUTF8(text))
}

// Key returns the path_key for path. It is safe for concurrent use.
// Invalid UTF-8 bytes become U+FFFD; protobuf strings are always valid UTF-8.
func Key(path string) string {
	return norm.NFC.String(fold(norm.NFD.String(validUTF8(path))))
}

// validUTF8 replaces each invalid UTF-8 byte of text with U+FFFD.
func validUTF8(text string) string {
	return string([]rune(text))
}

// fold applies full case folding to every code point, with the NTFS upcase
// merges: a Basic Multilingual Plane code point whose simple uppercase is
// also in the BMP and folds differently from it folds as that uppercase.
func fold(text string) string {
	var builder strings.Builder

	builder.Grow(len(text))

	for _, codePoint := range text {
		folded := foldCodePoint(codePoint)

		if upper := unicode.ToUpper(codePoint); upper != codePoint && codePoint <= 0xFFFF && upper <= 0xFFFF {
			if upperFolded := foldCodePoint(upper); upperFolded != folded {
				folded = upperFolded
			}
		}

		builder.WriteString(folded)
	}

	return builder.String()
}

// foldCodePoint returns the full case folding of codePoint.
func foldCodePoint(codePoint rune) string {
	caser := cases.Fold()
	folded := caser.String(string(codePoint))

	// cases.Fold lowercases the Cherokee capitals, which CaseFolding.txt
	// leaves as they are and folds the small letters to, so its result is
	// not a fixed point there. Such a code point folds as its lowercase.
	if caser.String(folded) != folded {
		folded = caser.String(string(unicode.ToLower(codePoint)))
	}

	return folded
}
