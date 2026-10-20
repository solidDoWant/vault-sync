package textcheck_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/solidDoWant/vault-sync/internal/textcheck"
)

func TestPrintable(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "empty", value: "", want: true},
		{name: "ASCII", value: "Laptop 2", want: true},
		{name: "multi-byte", value: "zoë-日本-😀", want: true},
		{name: "non-breaking space", value: "a\u00a0b", want: true},
		{name: "replacement character", value: "a�b", want: true},
		{name: "NUL", value: "a\x00b", want: false},
		{name: "escape", value: "a\x1bb", want: false},
		{name: "newline", value: "a\nb", want: false},
		{name: "tab", value: "a\tb", want: false},
		{name: "unit separator", value: "a\x1fb", want: false},
		{name: "DEL", value: "a\x7fb", want: false},
		{name: "C1 first", value: "a\u0080b", want: false},
		{name: "C1 last", value: "a\u009fb", want: false},
		{name: "invalid UTF-8", value: "a\xffb", want: false},
		{name: "truncated UTF-8", value: "a\xc3", want: false},
		{name: "UTF-8 encoded surrogate", value: "a\xed\xa0\x80b", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, textcheck.Printable(test.value))
		})
	}
}

func TestDisplayName(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "ASCII", value: "Laptop 2", want: true},
		{name: "multi-byte", value: "zoë-日本-😀", want: true},
		{name: "apostrophe and quotes", value: "Fred’s “work” \"iPhone\"", want: true},
		{name: "non-breaking space", value: "a\u00a0b", want: true},
		{name: "arabic letter", value: "aبb", want: true},
		{name: "control character", value: "a\x1bb", want: false},
		{name: "invalid UTF-8", value: "a\xffb", want: false},
		{name: "left-to-right embedding", value: "a\u202ab", want: false},
		{name: "right-to-left override", value: "a\u202eb", want: false},
		{name: "left-to-right isolate", value: "a\u2066b", want: false},
		{name: "pop directional isolate", value: "a\u2069b", want: false},
		{name: "right-to-left mark", value: "a\u200fb", want: false},
		{name: "zero-width space", value: "a\u200bb", want: false},
		{name: "zero-width joiner", value: "a\u200db", want: false},
		{name: "word joiner", value: "a\u2060b", want: false},
		{name: "byte order mark", value: "\ufeffab", want: false},
		{name: "soft hyphen", value: "a\u00adb", want: false},
		{name: "tag character", value: "a\U000e0041b", want: false},
		{name: "line separator", value: "a\u2028b", want: false},
		{name: "paragraph separator", value: "a\u2029b", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, textcheck.DisplayName(test.value))
		})
	}
}
