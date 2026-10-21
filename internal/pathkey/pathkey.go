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
// from CaseFolding.txt (e.g. it lowercases Cherokee). Normalization likewise
// uses tables generated from the vendored UnicodeData.txt and
// CompositionExclusions.txt rather than golang.org/x/text/unicode/norm, whose
// Unicode version lags behind. All tables come from one pinned Unicode
// version (17.0.0). The TypeScript client (plugin/src/core/pathkey) uses
// tables generated from the same files, so the two agree whatever Unicode
// version either runtime has; testdata/paths/vectors.json is the shared
// conformance suite and testdata/paths/NormalizationTest-17.0.0.txt.gz the
// Unicode normalization conformance suite both pass.
package pathkey

//go:generate go run ./gen -source gen/CaseFolding-17.0.0.txt -license gen/LICENSE-UNICODE.txt -go-out casefold_table.go -ts-out ../../plugin/src/core/pathkey/casefold-table.ts -unicode-data gen/UnicodeData-17.0.0.txt.gz -exclusions gen/CompositionExclusions-17.0.0.txt -go-norm-out normalization_table.go -ts-norm-out ../../plugin/src/core/pathkey/normalization-table.ts

import "strings"

// Key returns the path_key for path. It is safe for concurrent use.
func Key(path string) string {
	return nfc(fold(nfd(path)))
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
