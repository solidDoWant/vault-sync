//go:build integration

package blobstore_test

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
)

// recordingHandler is a slog.Handler that keeps every record, shared by the
// loggers of several simulated server processes.
type recordingHandler struct {
	mu      *sync.Mutex
	records *[]slog.Record
	attrs   []slog.Attr
}

func newRecordingHandler() *recordingHandler {
	return &recordingHandler{mu: &sync.Mutex{}, records: &[]slog.Record{}}
}

func (handler *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (handler *recordingHandler) Handle(_ context.Context, record slog.Record) error {
	record = record.Clone()
	record.AddAttrs(handler.attrs...)

	handler.mu.Lock()
	defer handler.mu.Unlock()

	*handler.records = append(*handler.records, record)

	return nil
}

func (handler *recordingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	clone := *handler
	clone.attrs = append(append([]slog.Attr{}, handler.attrs...), attrs...)

	return &clone
}

func (handler *recordingHandler) WithGroup(string) slog.Handler { return handler }

func (handler *recordingHandler) snapshot() []slog.Record {
	handler.mu.Lock()
	defer handler.mu.Unlock()

	return append([]slog.Record{}, *handler.records...)
}

func recordInt(record slog.Record, key string) int {
	value := 0

	record.Attrs(func(attr slog.Attr) bool {
		if attr.Key == key {
			value = int(attr.Value.Int64())

			return false
		}

		return true
	})

	return value
}

// Every server instance runs the upload cleaner on its own schedule (SPEC.md
// §12). Running it on several instances at once has the same effect as
// running it once: each abandoned session is removed exactly once, every
// stale multipart upload is aborted, and no instance logs a warning or an
// error because another instance got there first.
func TestCleanersOnEveryInstanceActAsOne(t *testing.T) {
	fixture := newCleanupFixture(t)

	var sessions []uuid.UUID

	for index := range 8 {
		upload := fixture.startUpload(t, fmt.Sprintf("abandoned %d", index), 3)
		fixture.idle(t, upload, 2*time.Hour)
		sessions = append(sessions, upload)
	}

	const multipartUploads = 20

	for index := range multipartUploads {
		fixture.createMultipart(t, fmt.Sprintf("interrupted %d", index))
	}

	active := fixture.startUpload(t, "active", 2)

	time.Sleep(20 * time.Millisecond)

	const instances = 4

	logs := newRecordingHandler()
	ctx, stop := context.WithCancel(t.Context())

	var group sync.WaitGroup

	for index := range instances {
		objects, err := blobstore.New(fixture.objectsConfig)
		require.NoError(t, err)

		cleaner := &blobstore.Cleaner{
			Store:   fixture.store,
			Objects: objects,
			// Long enough that the active session survives the test, short
			// enough that the multipart uploads are already stale.
			TTL:    time.Hour,
			Logger: slog.New(logs.WithAttrs([]slog.Attr{slog.Int("instance", index)})),
		}
		blobstore.SetClock(cleaner, func() time.Time { return time.Now().Add(2 * time.Hour) })

		group.Go(func() { cleaner.Run(ctx, 5*time.Millisecond) })
	}

	require.Eventually(t, func() bool {
		for _, upload := range sessions {
			if fixture.sessionExists(t, upload) {
				return false
			}
		}

		return fixture.multipartUploads(t) == 0
	}, 30*time.Second, 20*time.Millisecond, "the cleaners must remove the abandoned uploads")

	// Let every instance run several more times over the same state.
	time.Sleep(100 * time.Millisecond)
	stop()
	group.Wait()

	removed, aborted := 0, 0

	for _, record := range logs.snapshot() {
		assert.Less(t, record.Level, slog.LevelWarn, "instance %d logged %q", recordInt(record, "instance"), record.Message)

		removed += recordInt(record, "sessions")
		aborted += recordInt(record, "multipart_uploads")
	}

	assert.Equal(t, len(sessions), removed, "each abandoned session is removed exactly once")
	assert.LessOrEqual(t, aborted, multipartUploads)

	for _, upload := range sessions {
		assert.Zero(t, fixture.stagedObjects(t, upload))
	}

	assert.True(t, fixture.sessionExists(t, active), "an active session is left alone")
	assert.Equal(t, 2, fixture.stagedObjects(t, active))
}
