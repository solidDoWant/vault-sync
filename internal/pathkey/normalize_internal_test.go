package pathkey

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNormalizationOfInvalidUTF8(t *testing.T) {
	assert.Equal(t, "a�b", NFC("a\xffb"))
	assert.Equal(t, "a��b", Key("a\xff\xfeb"))
}
