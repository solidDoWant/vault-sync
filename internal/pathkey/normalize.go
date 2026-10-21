package pathkey

import "slices"

// Canonical normalization (Unicode §3.11, UAX #15) from the generated
// Unicode 17.0.0 tables in normalization_table.go, rather than
// golang.org/x/text/unicode/norm, whose tables lag behind (Unicode 15.0.0 at
// the time of writing). plugin/src/core/pathkey/normalize.ts implements the
// same algorithm over tables generated from the same data, so path_key never
// depends on either runtime's Unicode version.

// Hangul syllable constants (Unicode §3.12).
const (
	hangulSBase  = 0xAC00
	hangulLBase  = 0x1100
	hangulVBase  = 0x1161
	hangulTBase  = 0x11A7
	hangulLCount = 19
	hangulVCount = 21
	hangulTCount = 28
	hangulNCount = hangulVCount * hangulTCount
	hangulSCount = hangulLCount * hangulNCount
)

// nfd returns the canonical decomposition (NFD) of text. Invalid UTF-8 bytes
// become U+FFFD.
func nfd(text string) string {
	return string(decompose(text))
}

// nfc returns the canonical composition (NFC) of text. Invalid UTF-8 bytes
// become U+FFFD.
func nfc(text string) string {
	return string(compose(decompose(text)))
}

// decompose applies full canonical decomposition, then the canonical
// ordering algorithm.
func decompose(text string) []rune {
	codePoints := make([]rune, 0, len(text))

	for _, codePoint := range text {
		switch decomposition, ok := decompositions[codePoint]; {
		case ok:
			for _, part := range decomposition {
				codePoints = append(codePoints, part)
			}
		case codePoint >= hangulSBase && codePoint < hangulSBase+hangulSCount:
			index := codePoint - hangulSBase
			codePoints = append(codePoints, hangulLBase+index/hangulNCount, hangulVBase+(index%hangulNCount)/hangulTCount)

			if trailing := index % hangulTCount; trailing != 0 {
				codePoints = append(codePoints, hangulTBase+trailing)
			}
		default:
			codePoints = append(codePoints, codePoint)
		}
	}

	// Canonical ordering: stably sort every run of non-starters by
	// combining class.
	for start := 0; start < len(codePoints); {
		if combiningClasses[codePoints[start]] == 0 {
			start++

			continue
		}

		end := start + 1
		for end < len(codePoints) && combiningClasses[codePoints[end]] != 0 {
			end++
		}

		slices.SortStableFunc(codePoints[start:end], func(left, right rune) int {
			return int(combiningClasses[left]) - int(combiningClasses[right])
		})

		start = end
	}

	return codePoints
}

// compose applies the canonical composition algorithm to a canonically
// decomposed and ordered sequence, in place.
func compose(codePoints []rune) []rune {
	if len(codePoints) == 0 {
		return codePoints
	}

	starter := -1 // index in the output of the last starter
	if combiningClasses[codePoints[0]] == 0 {
		starter = 0
	}

	// lastClass is the combining class of the last code point written to
	// the output; 0 means it is the starter itself.
	lastClass := int(combiningClasses[codePoints[0]])
	if lastClass != 0 {
		lastClass = 256 // nothing before the first starter composes
	}

	length := 1

	for _, codePoint := range codePoints[1:] {
		class := int(combiningClasses[codePoint])

		if starter >= 0 && (lastClass < class || lastClass == 0) {
			if composite, ok := composePair(codePoints[starter], codePoint); ok {
				codePoints[starter] = composite

				continue
			}
		}

		if class == 0 {
			starter = length
		}

		lastClass = class
		codePoints[length] = codePoint
		length++
	}

	return codePoints[:length]
}

// composePair returns the primary composite of first and second, if any.
func composePair(first, second rune) (rune, bool) {
	if first >= hangulLBase && first < hangulLBase+hangulLCount &&
		second >= hangulVBase && second < hangulVBase+hangulVCount {
		return hangulSBase + ((first-hangulLBase)*hangulVCount+second-hangulVBase)*hangulTCount, true
	}

	if first >= hangulSBase && first < hangulSBase+hangulSCount && (first-hangulSBase)%hangulTCount == 0 &&
		second > hangulTBase && second < hangulTBase+hangulTCount {
		return first + second - hangulTBase, true
	}

	composite, ok := compositions[[2]rune{first, second}]

	return composite, ok
}
