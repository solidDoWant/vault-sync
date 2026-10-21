package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGeneratedNormalizationTablesAreUpToDate(t *testing.T) {
	normalization, err := LoadNormalization(UnicodeDataFile, ExclusionsFile)
	require.NoError(t, err)

	goTables, err := RenderGoNormalization(normalization)
	require.NoError(t, err)

	committedGo, err := os.ReadFile(filepath.Join("..", "normalization_table.go"))
	require.NoError(t, err)
	assert.Equal(t, string(goTables), string(committedGo), "Go normalization tables are stale: "+regenerate)

	committedTS, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin", "src", "core", "pathkey", "normalization-table.ts"))
	require.NoError(t, err)
	assert.Equal(t, string(RenderTypeScriptNormalization(normalization)), string(committedTS), "TypeScript normalization tables are stale: "+regenerate)
}

func TestParseNormalization(t *testing.T) {
	unicodeData := strings.Join([]string{
		"0041;LATIN CAPITAL LETTER A;Lu;0;L;;;;;N;;;;0061;",
		"0300;COMBINING GRAVE ACCENT;Mn;230;NSM;;;;;N;;;;;",
		"0301;COMBINING ACUTE ACCENT;Mn;230;NSM;;;;;N;;;;;",
		"0340;COMBINING GRAVE TONE MARK;Mn;230;NSM;0300;;;;N;;;;;",
		"0344;COMBINING GREEK DIALYTIKA TONOS;Mn;230;NSM;0308 0301;;;;N;;;;;",
		"00C0;LATIN CAPITAL LETTER A WITH GRAVE;Lu;0;L;0041 0300;;;;N;;;;00E0;",
		"1EA6;LATIN CAPITAL LETTER A WITH CIRCUMFLEX AND GRAVE;Lu;0;L;00C2 0300;;;;N;;;;1EA7;",
		"00C2;LATIN CAPITAL LETTER A WITH CIRCUMFLEX;Lu;0;L;0041 0302;;;;N;;;;00E2;",
		"0958;DEVANAGARI LETTER QA;Lo;0;L;0915 093C;;;;N;;;;;",
		"00A0;NO-BREAK SPACE;Zs;0;CS;<noBreak> 0020;;;;N;NBSP;;;;",
		"D800;<Non Private Use High Surrogate, First>;Cs;0;L;;;;;N;;;;;",
		"",
	}, "\n")
	exclusions := "# comment\n0958 # DEVANAGARI LETTER QA\n"

	normalization, err := ParseNormalization(strings.NewReader(unicodeData), strings.NewReader(exclusions))
	require.NoError(t, err)

	assert.Equal(t, map[rune]uint8{0x0300: 230, 0x0301: 230, 0x0340: 230, 0x0344: 230}, normalization.CombiningClasses)
	assert.Equal(t, []Mapping{
		{From: 0x00C0, To: []rune{0x41, 0x300}},
		{From: 0x00C2, To: []rune{0x41, 0x302}},
		{From: 0x0340, To: []rune{0x300}},
		{From: 0x0344, To: []rune{0x308, 0x301}},
		{From: 0x0958, To: []rune{0x915, 0x93C}},
		{From: 0x1EA6, To: []rune{0x41, 0x302, 0x300}}, // applied recursively
	}, normalization.Decompositions, "canonical decompositions only, fully decomposed")
	// 0340 is a singleton, 0344 a non-starter decomposition and 0958 a listed
	// exclusion: none of them is a primary composite.
	assert.Equal(t, []Composition{
		{First: 0x41, Second: 0x300, Composite: 0x00C0},
		{First: 0x41, Second: 0x302, Composite: 0x00C2},
		{First: 0xC2, Second: 0x300, Composite: 0x1EA6},
	}, normalization.Compositions)
}

func TestParseNormalizationRejectsMalformedData(t *testing.T) {
	tests := []struct {
		name        string
		unicodeData string
		exclusions  string
	}{
		{name: "too few fields", unicodeData: "0041;A;Lu;0\n"},
		{name: "invalid combining class", unicodeData: "0041;A;Lu;x;L;;;;;N;;;;;\n"},
		{name: "decomposition of three code points", unicodeData: "00C0;A;Lu;0;L;0041 0300 0301;;;;N;;;;;\n"},
		{name: "exclusion without a decomposition", unicodeData: "0041;A;Lu;0;L;;;;;N;;;;;\n", exclusions: "0041\n"},
		{name: "two composites for one pair", unicodeData: "00C0;A;Lu;0;L;0041 0300;;;;N;;;;;\n00C1;A;Lu;0;L;0041 0300;;;;N;;;;;\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ParseNormalization(strings.NewReader(test.unicodeData), strings.NewReader(test.exclusions))
			require.Error(t, err)
		})
	}
}
