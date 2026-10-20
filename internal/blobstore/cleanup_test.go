package blobstore_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
)

func TestCleanerRunsAreBoundedByDefault(t *testing.T) {
	tests := []struct {
		name       string
		runTimeout time.Duration
		want       time.Duration
	}{
		// The server builds its cleaner without a RunTimeout.
		{name: "unset", runTimeout: 0, want: 5 * time.Minute},
		{name: "negative", runTimeout: -time.Second, want: 5 * time.Minute},
		{name: "explicit", runTimeout: 3 * time.Second, want: 3 * time.Second},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cleaner := &blobstore.Cleaner{RunTimeout: test.runTimeout}
			assert.Equal(t, test.want, blobstore.CleanerRunTimeout(cleaner))
		})
	}
}
