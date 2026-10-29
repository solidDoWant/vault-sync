package main

import (
	"bufio"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
)

// LoadMappings returns the path_key folding mappings: full case folding from
// CaseFolding.txt at source, plus the NTFS upcase merges (UpcaseMerges)
// derived from the gzipped UnicodeData.txt at unicodeData.
func LoadMappings(source, unicodeData string) ([]Mapping, error) {
	file, err := os.Open(source)
	if err != nil {
		return nil, err
	}
	defer file.Close() //nolint:errcheck // read-only

	mappings, err := Parse(file)
	if err != nil {
		return nil, err
	}

	dataFile, err := os.Open(unicodeData)
	if err != nil {
		return nil, err
	}
	defer dataFile.Close() //nolint:errcheck // read-only

	decompressed, err := gzip.NewReader(dataFile)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", unicodeData, err)
	}

	upper, err := ParseSimpleUppercase(decompressed)
	if err != nil {
		return nil, err
	}

	return UpcaseMerges(mappings, upper), nil
}

// ParseSimpleUppercase reads UnicodeData.txt and returns the simple
// uppercase mapping (field 12) of every Basic Multilingual Plane code point
// whose mapping is also in the BMP. NTFS compares names by such a mapping
// of each UTF-16 code unit (its $UpCase table).
func ParseSimpleUppercase(reader io.Reader) (map[rune]rune, error) {
	upper := map[rune]rune{}

	scanner := bufio.NewScanner(reader)
	for line := 1; scanner.Scan(); line++ {
		fields := strings.Split(scanner.Text(), ";")
		if len(fields) != 15 {
			return nil, fmt.Errorf("UnicodeData line %d: expected 15 fields, got %d", line, len(fields))
		}

		if fields[12] == "" {
			continue
		}

		from, err := parseCodePoint(fields[0])
		if err != nil {
			return nil, fmt.Errorf("UnicodeData line %d: %w", line, err)
		}

		to, err := parseCodePoint(fields[12])
		if err != nil {
			return nil, fmt.Errorf("UnicodeData line %d: %w", line, err)
		}

		if from <= 0xFFFF && to <= 0xFFFF {
			upper[from] = to
		}
	}

	return upper, scanner.Err()
}

// UpcaseMerges adds to the case-folding mappings every code point that NTFS
// upcase takes for a character case folding keeps apart: a code point c
// whose uppercase folds differently from c itself then folds as its
// uppercase does. With Unicode 17.0.0 this is only the dotless ı (U+0131),
// which then folds to i like I. Every other key is unchanged. The result is
// sorted by code point.
func UpcaseMerges(mappings []Mapping, upper map[rune]rune) []Mapping {
	folding := make(map[rune][]rune, len(mappings))
	for _, mapping := range mappings {
		folding[mapping.From] = mapping.To
	}

	fold := func(codePoint rune) []rune {
		if to, ok := folding[codePoint]; ok {
			return to
		}

		return []rune{codePoint}
	}

	merged := slices.Clone(mappings)

	for from, to := range upper {
		if target := fold(to); !slices.Equal(target, fold(from)) {
			merged = slices.DeleteFunc(merged, func(mapping Mapping) bool { return mapping.From == from })
			merged = append(merged, Mapping{From: from, To: target})
		}
	}

	slices.SortFunc(merged, func(left, right Mapping) int { return int(left.From - right.From) })

	return merged
}
