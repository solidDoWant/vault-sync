package blobstore

import (
	"context"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// ComposeSlots exposes composeSlots to tests.
const ComposeSlots = composeSlots

// ClaimWaiting returns how many ClaimCompose calls wait for a claim.
func ClaimWaiting(objects *Objects) int {
	return int(objects.claimWaiting.Load())
}

// ComposeSlotsHeld returns how many of the replica's compose slots are held.
func ComposeSlotsHeld(objects *Objects) int {
	return len(objects.compose)
}

// ComposeWaiting returns how many compositions wait for a compose slot.
func ComposeWaiting(objects *Objects) int {
	return int(objects.waiting.Load())
}

// NewWithAttempts is New with the SDK making at most attempts attempts per
// call, so tests of failing calls need not wait for the retries' backoff.
func NewWithAttempts(cfg Config, attempts int) (*Objects, error) {
	return newObjects(cfg, func(options *s3.Options) { options.RetryMaxAttempts = attempts })
}

// ParseBlobKey exposes parseBlobKey to tests.
var ParseBlobKey = parseBlobKey

// SetAfterPart makes objects call hook after each multipart part it uploads
// while composing, before it reports progress.
func SetAfterPart(objects *Objects, hook func(ctx context.Context, number int32)) {
	objects.afterPart = hook
}

// SetBeforeSourceRead makes objects call hook before it opens each staged
// object while composing.
func SetBeforeSourceRead(objects *Objects, hook func(ctx context.Context, key string)) {
	objects.beforeSourceRead = hook
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
