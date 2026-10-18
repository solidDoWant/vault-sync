package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const regenerate = "run 'go generate ./internal/pathkey' and commit the result"

func loadMappings(t *testing.T) []Mapping {
	t.Helper()

	file, err := os.Open(SourceFile)
	require.NoError(t, err)

	t.Cleanup(func() { _ = file.Close() })

	mappings, err := Parse(file)
	require.NoError(t, err)

	return mappings
}

func TestGeneratedTablesAreUpToDate(t *testing.T) {
	mappings := loadMappings(t)

	goTable, err := RenderGo(mappings)
	require.NoError(t, err)

	committedGo, err := os.ReadFile(filepath.Join("..", "casefold_table.go"))
	require.NoError(t, err)
	assert.Equal(t, string(goTable), string(committedGo), "Go table is stale: "+regenerate)

	committedTS, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin", "src", "core", "pathkey", "casefold-table.ts"))
	require.NoError(t, err)
	assert.Equal(t, string(RenderTypeScript(mappings)), string(committedTS), "TypeScript table is stale: "+regenerate)
}

func TestParse(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		expected    []Mapping
		assertError require.ErrorAssertionFunc
	}{
		{
			name: "keeps C and F, skips S and T, sorts",
			input: strings.Join([]string{
				"# comment",
				"1E9E; F; 0073 0073; # LATIN CAPITAL LETTER SHARP S",
				"1E9E; S; 00DF; # LATIN CAPITAL LETTER SHARP S",
				"0049; T; 0131; # LATIN CAPITAL LETTER I",
				"0041; C; 0061; # LATIN CAPITAL LETTER A",
				"",
			}, "\n"),
			expected: []Mapping{
				{From: 'A', To: []rune{'a'}},
				{From: 0x1E9E, To: []rune{'s', 's'}},
			},
		},
		{
			name:        "rejects malformed lines",
			input:       "0041; C\n",
			assertError: require.Error,
		},
		{
			name:        "rejects surrogates",
			input:       "D800; C; 0061;\n",
			assertError: require.Error,
		},
		{
			name:        "rejects duplicate mappings",
			input:       "0041; C; 0061;\n0041; F; 0061;\n",
			assertError: require.Error,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.assertError == nil {
				test.assertError = require.NoError
			}

			mappings, err := Parse(strings.NewReader(test.input))
			test.assertError(t, err)

			if err == nil {
				assert.Equal(t, test.expected, mappings)
			}
		})
	}
}

func TestVendoredDataIsCompleteAndLocaleIndependent(t *testing.T) {
	byCodePoint := make(map[rune][]rune)
	for _, mapping := range loadMappings(t) {
		byCodePoint[mapping.From] = mapping.To
	}

	assert.Equal(t, []rune("ss"), byCodePoint['ß'], "full folding of sharp s")
	assert.Equal(t, []rune("i̇"), byCodePoint['İ'], "full folding of capital dotted I")
	assert.Equal(t, []rune("i"), byCodePoint['I'], "default (non-Turkic) folding of I")
	assert.Equal(t, []rune("Ꭰ"), byCodePoint['ꭰ'], "Cherokee folds to uppercase")
	assert.NotContains(t, byCodePoint, rune(0x13A0), "Cherokee uppercase folds to itself")
	assert.NotContains(t, byCodePoint, rune('ı'), "dotless i folds to itself")
}
