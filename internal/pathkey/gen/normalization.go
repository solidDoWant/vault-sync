package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"fmt"
	"go/format"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"
)

// UnicodeDataFile is the vendored, gzipped (otherwise unmodified)
// UnicodeData.txt, relative to this package.
const UnicodeDataFile = "UnicodeData-" + UnicodeVersion + ".txt.gz"

// ExclusionsFile is the vendored CompositionExclusions.txt, relative to this
// package.
const ExclusionsFile = "CompositionExclusions-" + UnicodeVersion + ".txt"

// Normalization is the canonical normalization data (Unicode §3.11, UAX #15)
// that path_key needs, excluding Hangul syllables, which are algorithmic.
type Normalization struct {
	// CombiningClasses holds every code point whose canonical combining class
	// is nonzero.
	CombiningClasses map[rune]uint8
	// Decompositions maps every code point that has a canonical decomposition
	// to its full (recursively applied) canonical decomposition, sorted by
	// code point.
	Decompositions []Mapping
	// Compositions lists every primary composite: a code point whose
	// canonical decomposition is exactly two code points and which is not
	// Full_Composition_Exclusion. Sorted by first, then second code point.
	Compositions []Composition
}

// Composition is one canonical composition pair.
type Composition struct {
	First, Second, Composite rune
}

// LoadNormalization reads the gzipped UnicodeData.txt and
// CompositionExclusions.txt at the given paths.
func LoadNormalization(unicodeData, exclusions string) (*Normalization, error) {
	dataFile, err := os.Open(unicodeData)
	if err != nil {
		return nil, err
	}
	defer dataFile.Close() //nolint:errcheck // read-only

	decompressed, err := gzip.NewReader(dataFile)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", unicodeData, err)
	}

	exclusionsFile, err := os.Open(exclusions)
	if err != nil {
		return nil, err
	}
	defer exclusionsFile.Close() //nolint:errcheck // read-only

	return ParseNormalization(decompressed, exclusionsFile)
}

// ParseNormalization derives the normalization data from UnicodeData.txt and
// CompositionExclusions.txt. Full_Composition_Exclusion (UAX #44) is the
// union of the listed exclusions, singleton decompositions and non-starter
// decompositions (the code point or the first code point of its
// decomposition has a nonzero combining class).
func ParseNormalization(unicodeData, exclusions io.Reader) (*Normalization, error) {
	classes := make(map[rune]uint8)
	single := make(map[rune][]rune)

	scanner := bufio.NewScanner(unicodeData)
	for line := 1; scanner.Scan(); line++ {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}

		fields := strings.Split(scanner.Text(), ";")
		if len(fields) != 15 {
			return nil, fmt.Errorf("UnicodeData line %d: expected 15 fields, got %d", line, len(fields))
		}

		if value, err := strconv.ParseUint(fields[0], 16, 32); err == nil && value >= 0xD800 && value <= 0xDFFF {
			continue // surrogate range bounds: class 0, no decomposition
		}

		codePoint, err := parseCodePoint(fields[0])
		if err != nil {
			return nil, fmt.Errorf("UnicodeData line %d: %w", line, err)
		}

		class, err := strconv.ParseUint(fields[3], 10, 8)
		if err != nil {
			return nil, fmt.Errorf("UnicodeData line %d: invalid combining class %q: %w", line, fields[3], err)
		}

		if class != 0 {
			classes[codePoint] = uint8(class)
		}

		// Compatibility decompositions start with a <tag>; path_key uses
		// canonical equivalence only.
		if fields[5] == "" || strings.HasPrefix(fields[5], "<") {
			continue
		}

		var decomposition []rune

		for _, field := range strings.Fields(fields[5]) {
			part, err := parseCodePoint(field)
			if err != nil {
				return nil, fmt.Errorf("UnicodeData line %d: %w", line, err)
			}

			decomposition = append(decomposition, part)
		}

		if len(decomposition) > 2 {
			return nil, fmt.Errorf("UnicodeData line %d: canonical decomposition of %U has more than 2 code points", line, codePoint)
		}

		single[codePoint] = decomposition
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	excluded, err := parseExclusions(exclusions)
	if err != nil {
		return nil, err
	}

	for codePoint := range excluded {
		if _, ok := single[codePoint]; !ok {
			return nil, fmt.Errorf("composition exclusion %U has no canonical decomposition", codePoint)
		}
	}

	normalization := &Normalization{CombiningClasses: classes}

	for codePoint, decomposition := range single {
		normalization.Decompositions = append(normalization.Decompositions, Mapping{
			From: codePoint,
			To:   fullDecomposition(single, codePoint),
		})

		if len(decomposition) == 1 || excluded[codePoint] ||
			classes[codePoint] != 0 || classes[decomposition[0]] != 0 {
			continue // Full_Composition_Exclusion
		}

		normalization.Compositions = append(normalization.Compositions, Composition{
			First:     decomposition[0],
			Second:    decomposition[1],
			Composite: codePoint,
		})
	}

	slices.SortFunc(normalization.Decompositions, func(left, right Mapping) int { return int(left.From - right.From) })
	slices.SortFunc(normalization.Compositions, func(left, right Composition) int {
		if left.First != right.First {
			return int(left.First - right.First)
		}

		return int(left.Second - right.Second)
	})

	for index := 1; index < len(normalization.Compositions); index++ {
		previous, current := normalization.Compositions[index-1], normalization.Compositions[index]
		if previous.First == current.First && previous.Second == current.Second {
			return nil, fmt.Errorf("%U and %U share the composition pair %U %U", previous.Composite, current.Composite, current.First, current.Second)
		}
	}

	return normalization, nil
}

func fullDecomposition(single map[rune][]rune, codePoint rune) []rune {
	decomposition, ok := single[codePoint]
	if !ok {
		return []rune{codePoint}
	}

	var full []rune
	for _, part := range decomposition {
		full = append(full, fullDecomposition(single, part)...)
	}

	return full
}

func parseExclusions(reader io.Reader) (map[rune]bool, error) {
	excluded := make(map[rune]bool)

	scanner := bufio.NewScanner(reader)
	for line := 1; scanner.Scan(); line++ {
		text, _, _ := strings.Cut(scanner.Text(), "#")
		if strings.TrimSpace(text) == "" {
			continue
		}

		codePoint, err := parseCodePoint(text)
		if err != nil {
			return nil, fmt.Errorf("CompositionExclusions line %d: %w", line, err)
		}

		excluded[codePoint] = true
	}

	return excluded, scanner.Err()
}

// classRange is a run of consecutive code points with the same nonzero
// combining class.
type classRange struct {
	first, last rune
	class       uint8
}

func (normalization *Normalization) classRanges() []classRange {
	codePoints := make([]rune, 0, len(normalization.CombiningClasses))
	for codePoint := range normalization.CombiningClasses {
		codePoints = append(codePoints, codePoint)
	}

	slices.Sort(codePoints)

	var ranges []classRange

	for _, codePoint := range codePoints {
		class := normalization.CombiningClasses[codePoint]
		if last := len(ranges) - 1; last >= 0 && ranges[last].last == codePoint-1 && ranges[last].class == class {
			ranges[last].last = codePoint

			continue
		}

		ranges = append(ranges, classRange{first: codePoint, last: codePoint, class: class})
	}

	return ranges
}

const normalizationHeader = "Code generated by internal/pathkey/gen from " + UnicodeDataFile + " and " + ExclusionsFile + ". DO NOT EDIT."

// RenderGoNormalization renders the Go normalization tables for package
// pathkey.
func RenderGoNormalization(normalization *Normalization) ([]byte, error) {
	var buffer bytes.Buffer

	fmt.Fprintf(&buffer, "// %s\n\n", normalizationHeader)
	fmt.Fprintf(&buffer, "// Derived from Unicode data under the Unicode License v3; see\n// internal/pathkey/gen/%s.\n\npackage pathkey\n\n", LicenseFile)
	buffer.WriteString("// combiningClasses holds every code point whose canonical combining class is\n// nonzero.\n")
	buffer.WriteString("var combiningClasses = map[rune]uint8{\n")

	for _, classRange := range normalization.classRanges() {
		for codePoint := classRange.first; codePoint <= classRange.last; codePoint++ {
			fmt.Fprintf(&buffer, "\t0x%04X: %d,\n", codePoint, classRange.class)
		}
	}

	buffer.WriteString("}\n\n")
	buffer.WriteString("// decompositions maps each code point to its full canonical decomposition.\n// Hangul syllables are decomposed algorithmically and are not listed.\n")
	buffer.WriteString("var decompositions = map[rune]string{\n")

	for _, mapping := range normalization.Decompositions {
		fmt.Fprintf(&buffer, "\t0x%04X: %s,\n", mapping.From, strconv.QuoteToASCII(string(mapping.To)))
	}

	buffer.WriteString("}\n\n")
	buffer.WriteString("// compositions maps each canonical composition pair to its primary\n// composite. Hangul syllables are composed algorithmically and are not listed.\n")
	buffer.WriteString("var compositions = map[[2]rune]rune{\n")

	for _, composition := range normalization.Compositions {
		fmt.Fprintf(&buffer, "\t{0x%04X, 0x%04X}: 0x%04X,\n", composition.First, composition.Second, composition.Composite)
	}

	buffer.WriteString("}\n")

	return format.Source(buffer.Bytes())
}

// RenderTypeScriptNormalization renders the TypeScript normalization tables
// for plugin/src/core/pathkey, in the same comma-separated, space-separated
// hex format as the case-folding table.
func RenderTypeScriptNormalization(normalization *Normalization) []byte {
	var buffer bytes.Buffer

	fmt.Fprintf(&buffer, "// %s\n\n", normalizationHeader)
	fmt.Fprintf(&buffer, "// Derived from Unicode data under the Unicode License v3; see the notice in\n// casefold-table.ts (internal/pathkey/gen/%s in the vault-sync repository).\n\n", LicenseFile)
	fmt.Fprintf(&buffer, "/** Unicode version of the normalization tables. */\nexport const NORMALIZATION_UNICODE_VERSION = %q;\n\n", UnicodeVersion)

	ranges := normalization.classRanges()
	classEntries := make([]string, 0, len(ranges))

	for _, classRange := range ranges {
		entry := hex(classRange.first)
		if classRange.last != classRange.first {
			entry += "-" + hex(classRange.last)
		}

		classEntries = append(classEntries, entry+" "+strconv.FormatUint(uint64(classRange.class), 16))
	}

	buffer.WriteString("/**\n * Nonzero canonical combining classes as comma-separated entries: a code\n * point or an inclusive range (`first-last`), then the class, all in hex.\n */\n")
	writeTypeScriptConstant(&buffer, "COMBINING_CLASS_DATA", classEntries)

	decompositionEntries := make([]string, 0, len(normalization.Decompositions))

	for _, mapping := range normalization.Decompositions {
		parts := []string{hex(mapping.From)}
		for _, codePoint := range mapping.To {
			parts = append(parts, hex(codePoint))
		}

		decompositionEntries = append(decompositionEntries, strings.Join(parts, " "))
	}

	buffer.WriteString("\n/**\n * Full canonical decompositions as comma-separated entries of space-separated\n * hex code points: source, then its decomposition. Hangul is algorithmic.\n */\n")
	writeTypeScriptConstant(&buffer, "DECOMPOSITION_DATA", decompositionEntries)

	compositionEntries := make([]string, 0, len(normalization.Compositions))

	for _, composition := range normalization.Compositions {
		compositionEntries = append(compositionEntries, hex(composition.First)+" "+hex(composition.Second)+" "+hex(composition.Composite))
	}

	buffer.WriteString("\n/**\n * Canonical composition pairs as comma-separated entries of space-separated\n * hex code points: first, second, primary composite. Hangul is algorithmic.\n */\n")
	writeTypeScriptConstant(&buffer, "COMPOSITION_DATA", compositionEntries)

	return buffer.Bytes()
}

func hex(codePoint rune) string {
	return strconv.FormatInt(int64(codePoint), 16)
}

func writeTypeScriptConstant(buffer *bytes.Buffer, name string, entries []string) {
	const perLine = 8

	fmt.Fprintf(buffer, "export const %s =\n", name)

	for start := 0; start < len(entries); start += perLine {
		end := min(start+perLine, len(entries))

		separator := ","
		terminator := " +\n"

		if end == len(entries) {
			separator = ""
			terminator = ";\n"
		}

		fmt.Fprintf(buffer, "  %q%s", strings.Join(entries[start:end], ",")+separator, terminator)
	}
}
