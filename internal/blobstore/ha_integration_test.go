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

// assertMultipartAbortCounts checks the multipart uploads each of several
// concurrent cleaner instances reported aborting, given how many stale
// uploads there were. Every upload's abort was acknowledged to at least one
// instance, and no instance counts an upload twice. The total may exceed the
// number of uploads: when several instances abort the same upload at the
// same moment, the object store may acknowledge each of them (S3 documents
// aborting as repeatable, and the test store does this). The extra
// acknowledgements change nothing because the upload is gone either way, so
// they are not double work and are not asserted against.
func assertMultipartAbortCounts(t *testing.T, abortedBy []int, uploads int) {
	t.Helper()

	total := 0

	for instance, aborted := range abortedBy {
		assert.LessOrEqual(t, aborted, uploads, "instance %d counted an upload more than once", instance)

		total += aborted
	}

	assert.GreaterOrEqual(t, total, uploads, "every stale multipart upload's abort is counted")
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

	removed := 0
	abortedBy := make([]int, instances)

	for _, record := range logs.snapshot() {
		instance := recordInt(record, "instance")
		assert.Less(t, record.Level, slog.LevelWarn, "instance %d logged %q", instance, record.Message)

		removed += recordInt(record, "sessions")
		abortedBy[instance] += recordInt(record, "multipart_uploads")
	}

	assert.Equal(t, len(sessions), removed, "each abandoned session is removed exactly once")
	assertMultipartAbortCounts(t, abortedBy, multipartUploads)

	for _, upload := range sessions {
		assert.Zero(t, fixture.stagedObjects(t, upload))
	}

	assert.True(t, fixture.sessionExists(t, active), "an active session is left alone")
	assert.Equal(t, 2, fixture.stagedObjects(t, active))
}
