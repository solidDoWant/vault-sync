package pathkey

import (
	"bufio"
	"compress/gzip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNormalizationConformance runs the Unicode normalization conformance
// suite (NormalizationTest.txt) of the pinned Unicode version against nfd
// and nfc. The TypeScript client runs the same file
// (plugin/test/normalization-conformance.test.ts).
func TestNormalizationConformance(t *testing.T) {
	file, err := os.Open(filepath.Join("..", "..", "testdata", "paths", "NormalizationTest-"+unicodeVersion+".txt.gz"))
	require.NoError(t, err)

	t.Cleanup(func() { _ = file.Close() })

	decompressed, err := gzip.NewReader(file)
	require.NoError(t, err)

	listedInPart1 := make(map[rune]bool)
	part := ""
	cases := 0

	scanner := bufio.NewScanner(decompressed)
	for line := 1; scanner.Scan(); line++ {
		text, _, _ := strings.Cut(scanner.Text(), "#")
		if strings.HasPrefix(text, "@") {
			part = strings.TrimSpace(text)

			continue
		}

		if strings.TrimSpace(text) == "" {
			continue
		}

		fields := strings.Split(text, ";")
		require.GreaterOrEqual(t, len(fields), 5, "line %d", line)

		columns := make([]string, 5)
		for index := range columns {
			columns[index] = parseSequence(t, fields[index])
		}

		if part == "@Part1" {
			codePoint, _ := utf8.DecodeRuneInString(columns[0])
			listedInPart1[codePoint] = true
		}

		// c3 == toNFD(c1) == toNFD(c2) == toNFD(c3); c5 == toNFD(c4) == toNFD(c5)
		// c2 == toNFC(c1) == toNFC(c2) == toNFC(c3); c4 == toNFC(c4) == toNFC(c5)
		for index := range 3 {
			assert.Equal(t, columns[2], nfd(columns[index]), "line %d: NFD(c%d)", line, index+1)
			assert.Equal(t, columns[1], nfc(columns[index]), "line %d: NFC(c%d)", line, index+1)
		}

		for index := 3; index < 5; index++ {
			assert.Equal(t, columns[4], nfd(columns[index]), "line %d: NFD(c%d)", line, index+1)
			assert.Equal(t, columns[3], nfc(columns[index]), "line %d: NFC(c%d)", line, index+1)
		}

		cases++
	}

	require.NoError(t, scanner.Err())
	require.Greater(t, cases, 10000, "the conformance suite must have been read")

	// Every code point not listed in part 1 is unchanged by both forms.
	for codePoint := rune(0); codePoint <= unicode.MaxRune; codePoint++ {
		if !utf8.ValidRune(codePoint) || listedInPart1[codePoint] {
			continue
		}

		text := string(codePoint)
		if nfd(text) != text || nfc(text) != text {
			t.Errorf("%U is not listed in part 1 but normalization changes it", codePoint)
		}
	}
}

func parseSequence(t *testing.T, field string) string {
	t.Helper()

	var builder strings.Builder

	for _, hex := range strings.Fields(field) {
		value, err := strconv.ParseUint(hex, 16, 32)
		require.NoError(t, err)
		builder.WriteRune(rune(value))
	}

	return builder.String()
}

func TestNormalizationOfInvalidUTF8(t *testing.T) {
	assert.Equal(t, "a�b", nfc("a\xffb"))
	assert.Equal(t, "a�b", nfd("a\xffb"))
}
