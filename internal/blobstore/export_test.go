package blobstore

import (
	"context"
	"time"
)

// ParseBlobKey exposes parseBlobKey to tests.
var ParseBlobKey = parseBlobKey

// SetAfterPart makes objects call hook after each multipart part it uploads
// while composing, before it reports progress.
func SetAfterPart(objects *Objects, hook func(ctx context.Context, number int32)) {
	objects.afterPart = hook
}

// AbortStaleMultipartUploads runs one listing pass of the multipart sweep
// from the start, with at most pages pages.
func AbortStaleMultipartUploads(ctx context.Context, objects *Objects, cutoff time.Time, pages int, spare func(ctx context.Context, key string) (bool, error)) (int, error) {
	aborted, _, err := objects.abortStaleMultipartUploads(ctx, "vaults/", cutoff, multipartCursor{}, pages, spare)

	return aborted, err
}

// SetClock makes cleaner's multipart sweep use now instead of time.Now.
func SetClock(cleaner *Cleaner, now func() time.Time) {
	cleaner.now = now
}
