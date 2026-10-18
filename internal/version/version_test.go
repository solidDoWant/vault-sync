package version

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestString(t *testing.T) {
	tests := []struct {
		name    string
		stamped string
		want    string
	}{
		{name: "unstamped build", stamped: "", want: "unknown"},
		{name: "stamped build", stamped: "1.2.3", want: "1.2.3"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			original := version

			t.Cleanup(func() { version = original })

			version = test.stamped
			assert.Equal(t, test.want, String())
		})
	}
}
