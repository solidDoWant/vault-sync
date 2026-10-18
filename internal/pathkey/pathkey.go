// Package pathkey derives the normalized path_key used to enforce per-vault
// path uniqueness (SPEC.md §5).
//
// A path_key is NFC(toCasefold(NFD(path))): Unicode canonical caseless
// matching (Unicode §3.13, D145) with full, locale-independent case folding
// (CaseFolding.txt statuses C and F, never T), emitted in NFC. Two paths that
// would collide on a case-insensitive, normalization-insensitive filesystem
// get the same key. Nothing else is altered: separators, whitespace and dots
// are preserved, and no validation is performed.
//
// Case folding uses a table generated from the vendored Unicode
// CaseFolding.txt rather than golang.org/x/text/cases, whose Fold diverges
// from CaseFolding.txt (e.g. it lowercases Cherokee). The TypeScript client
// (plugin/src/core/pathkey) uses a table generated from the same file, and
// testdata/paths/vectors.json is the shared conformance suite.
package pathkey

//go:generate go run ./gen -source gen/CaseFolding-17.0.0.txt -go-out casefold_table.go -ts-out ../../plugin/src/core/pathkey/casefold-table.ts

import (
	"strings"

	"golang.org/x/text/unicode/norm"
)

// Key returns the path_key for path. It is safe for concurrent use.
func Key(path string) string {
	return norm.NFC.String(fold(norm.NFD.String(path)))
}

// fold applies full case folding to every code point. Invalid UTF-8 bytes
// become U+FFFD; protobuf strings are always valid UTF-8.
func fold(text string) string {
	var builder strings.Builder

	builder.Grow(len(text))

	for _, codePoint := range text {
		if folded, ok := foldTable[codePoint]; ok {
			builder.WriteString(folded)
		} else {
			builder.WriteRune(codePoint)
		}
	}

	return builder.String()
}
