package blobstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	"github.com/google/uuid"
)

const (
	// PartSize is the size of the multipart-upload parts a blob's object is
	// composed from, and the largest blob written with a single PutObject.
	// S3 requires parts of at least 5 MiB (except the last) and at most
	// 10,000 parts, so blobs up to 80 GiB can be composed.
	PartSize = 8 << 20
	// MaxParts is S3's limit on parts per multipart upload.
	MaxParts = 10000
	// MaxBlobBytes is the largest blob that can be composed.
	MaxBlobBytes = PartSize * MaxParts
	// MinChunkBytes is the smallest chunk accepted anywhere but at the end
	// of a blob (or the maximum chunk size, if smaller). It bounds how many
	// staged objects one upload can create.
	MinChunkBytes = 64 << 10

	// composeSlots bounds concurrent compositions, each of which buffers
	// one part in memory.
	composeSlots = 4
	// deleteBatch is S3's limit on keys per DeleteObjects request.
	deleteBatch = 1000
	// ProgressInterval is how often Compose reports progress while it waits
	// for a compose slot. Together with a report after every part, it keeps
	// a commit's upload session active far more often than the shortest
	// upload TTL (10 minutes) requires.
	ProgressInterval = time.Minute
)

// ErrHashMismatch is returned by Compose when the composed content does not
// pass verification. Nothing is written.
var ErrHashMismatch = errors.New("blob content does not match its id")

// ErrCorrupt is returned when a stored object does not have the length its
// metadata records.
var ErrCorrupt = errors.New("stored object has an unexpected length")

// Objects reads and writes blob objects in one bucket.
type Objects struct {
	client  *s3.Client
	bucket  string
	compose chan struct{}

	// afterPart, if set (by tests only), runs after each multipart part is
	// uploaded and before progress is reported.
	afterPart func(ctx context.Context, number int32)
}

// New returns an Objects for cfg. It does not contact the store.
func New(cfg Config) (*Objects, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return &Objects{client: newClient(cfg), bucket: cfg.Bucket, compose: make(chan struct{}, composeSlots)}, nil
}

// Client returns the underlying S3 client.
func (objects *Objects) Client() *s3.Client {
	return objects.client
}

// Bucket returns the bucket name.
func (objects *Objects) Bucket() string {
	return objects.bucket
}

// Check verifies that the bucket exists and the credentials can reach it.
func (objects *Objects) Check(ctx context.Context) error {
	_, err := objects.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(objects.bucket)})
	if err != nil {
		return fmt.Errorf("reach S3 bucket %q: %w", objects.bucket, err)
	}

	return nil
}

// VaultPrefix is the key prefix of everything stored for vaultID.
func VaultPrefix(vaultID uuid.UUID) string {
	return "vaults/" + vaultID.String() + "/"
}

// BlobKey is the key of a complete blob's object (SPEC.md §5).
func BlobKey(vaultID uuid.UUID, blobID []byte) string {
	return VaultPrefix(vaultID) + "blobs/" + hex.EncodeToString(blobID)
}

// UploadPrefix is the key prefix of an upload session's staged chunks.
func UploadPrefix(vaultID, uploadID uuid.UUID) string {
	return VaultPrefix(vaultID) + "uploads/" + uploadID.String() + "/"
}

// ChunkKey is the key of one staged chunk. The token makes the key unique to
// one write, so a writer that loses the race for an offset cannot overwrite
// the accepted chunk.
func ChunkKey(vaultID, uploadID uuid.UUID, offset int64, token uuid.UUID) string {
	return fmt.Sprintf("%s%020d-%s", UploadPrefix(vaultID, uploadID), offset, token)
}

// Put stores data at key.
func (objects *Objects) Put(ctx context.Context, key string, data []byte) error {
	_, err := objects.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(objects.bucket),
		Key:           aws.String(key),
		Body:          bytes.NewReader(data),
		ContentLength: aws.Int64(int64(len(data))),
	})
	if err != nil {
		return fmt.Errorf("put object: %w", err)
	}

	return nil
}

// Delete removes key. Removing a missing key succeeds.
func (objects *Objects) Delete(ctx context.Context, key string) error {
	_, err := objects.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(objects.bucket), Key: aws.String(key)})
	if err != nil && !isNotFound(err, "NoSuchKey") {
		return fmt.Errorf("delete object: %w", err)
	}

	return nil
}

// ReadRange returns exactly length bytes of key starting at offset. The
// caller bounds length.
func (objects *Objects) ReadRange(ctx context.Context, key string, offset, length int64) ([]byte, error) {
	if length == 0 {
		return []byte{}, nil
	}

	output, err := objects.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(objects.bucket),
		Key:    aws.String(key),
		Range:  aws.String(fmt.Sprintf("bytes=%d-%d", offset, offset+length-1)),
	})
	if err != nil {
		return nil, fmt.Errorf("get object: %w", err)
	}

	defer func() { _ = output.Body.Close() }()

	data := make([]byte, length)
	if _, err := io.ReadFull(output.Body, data); err != nil {
		return nil, fmt.Errorf("read object: %w", errors.Join(ErrCorrupt, err))
	}

	return data, nil
}

// ErrNoObject is returned by Open when key does not exist.
var ErrNoObject = errors.New("object does not exist")

// Open returns a reader streaming the whole object at key, so callers never
// hold more than their own buffer in memory. The caller closes it and bounds
// how much it reads.
func (objects *Objects) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	output, err := objects.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(objects.bucket), Key: aws.String(key)})
	if isNotFound(err, "NoSuchKey") {
		return nil, ErrNoObject
	}

	if err != nil {
		return nil, fmt.Errorf("get object: %w", err)
	}

	return output.Body, nil
}

// Part is one staged object to compose, of a known length.
type Part struct {
	Key    string
	Length int64
}

// Progress is called by Compose as it makes progress: at least every
// ProgressInterval while it waits for a compose slot, once it has one, after
// every part it uploads, and right before it makes the object visible. An
// error stops the composition, and nothing becomes visible at the key.
type Progress func(ctx context.Context) error

// Compose concatenates sources, which total size bytes, into the object at
// key. It hashes the content with SHA-256 and passes the digest to verify
// before anything becomes visible at key: if verify (or anything else)
// fails, key is not written. A nil verify accepts any content; a nil
// progress is not called.
func (objects *Objects) Compose(ctx context.Context, key string, sources []Part, size int64, verify func(sum []byte) error, progress Progress) error {
	if size > MaxBlobBytes {
		return fmt.Errorf("blob of %d bytes exceeds the composable maximum of %d", size, int64(MaxBlobBytes))
	}

	if progress == nil {
		progress = func(context.Context) error { return nil }
	}

	if err := objects.acquireComposeSlot(ctx, progress); err != nil {
		return err
	}

	defer func() { <-objects.compose }()

	reader := &sourceReader{ctx: ctx, objects: objects, sources: sources, hash: sha256.New()}

	if size <= PartSize {
		return objects.composeSingle(ctx, key, reader, size, verify, progress)
	}

	return objects.composeMultipart(ctx, key, reader, size, verify, progress)
}

// acquireComposeSlot waits for a compose slot, reporting progress while it
// waits: a commit queued behind others is still in progress.
func (objects *Objects) acquireComposeSlot(ctx context.Context, progress Progress) error {
	ticker := time.NewTicker(ProgressInterval)
	defer ticker.Stop()

	for {
		select {
		case objects.compose <- struct{}{}:
			if err := progress(ctx); err != nil {
				<-objects.compose

				return err
			}

			return nil
		case <-ticker.C:
			if err := progress(ctx); err != nil {
				return err
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (objects *Objects) composeSingle(ctx context.Context, key string, reader *sourceReader, size int64, verify func([]byte) error, progress Progress) error {
	data := make([]byte, size)
	if _, err := io.ReadFull(reader, data); err != nil {
		return err
	}

	if err := reader.finish(verify); err != nil {
		return err
	}

	if err := progress(ctx); err != nil {
		return err
	}

	return objects.Put(ctx, key, data)
}

func (objects *Objects) composeMultipart(ctx context.Context, key string, reader *sourceReader, size int64, verify func([]byte) error, progress Progress) (err error) {
	created, err := objects.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(objects.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("create multipart upload: %w", err)
	}

	uploadID := created.UploadId

	defer func() {
		if err == nil {
			return
		}

		// Abort even when ctx is canceled: an unfinished multipart upload
		// is invisible and would otherwise leak (the cleanup routine also
		// aborts stale ones).
		abortCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()

		_, _ = objects.client.AbortMultipartUpload(abortCtx, &s3.AbortMultipartUploadInput{
			Bucket: aws.String(objects.bucket), Key: aws.String(key), UploadId: uploadID,
		})
	}()

	buffer := make([]byte, PartSize)

	var completed []types.CompletedPart

	for remaining, number := size, int32(1); remaining > 0; number++ {
		part := buffer[:min(remaining, PartSize)]
		if _, err := io.ReadFull(reader, part); err != nil {
			return err
		}

		uploaded, err := objects.client.UploadPart(ctx, &s3.UploadPartInput{
			Bucket:        aws.String(objects.bucket),
			Key:           aws.String(key),
			UploadId:      uploadID,
			PartNumber:    aws.Int32(number),
			Body:          bytes.NewReader(part),
			ContentLength: aws.Int64(int64(len(part))),
		})
		if err != nil {
			return fmt.Errorf("upload part %d: %w", number, err)
		}

		completed = append(completed, types.CompletedPart{ETag: uploaded.ETag, PartNumber: aws.Int32(number)})
		remaining -= int64(len(part))

		if objects.afterPart != nil {
			objects.afterPart(ctx, number)
		}

		if err := progress(ctx); err != nil {
			return err
		}
	}

	if err := reader.finish(verify); err != nil {
		return err
	}

	if err := progress(ctx); err != nil {
		return err
	}

	_, err = objects.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:          aws.String(objects.bucket),
		Key:             aws.String(key),
		UploadId:        uploadID,
		MultipartUpload: &types.CompletedMultipartUpload{Parts: completed},
	})
	if err != nil {
		return fmt.Errorf("complete multipart upload: %w", err)
	}

	return nil
}

// sourceReader reads staged objects in order, checking each one's length,
// and hashes everything read.
type sourceReader struct {
	ctx     context.Context // scoped to one Compose call
	objects *Objects
	sources []Part
	hash    hash.Hash
	current io.ReadCloser
	left    int64
}

func (reader *sourceReader) Read(buffer []byte) (int, error) {
	for reader.current == nil {
		if len(reader.sources) == 0 {
			return 0, io.EOF
		}

		source := reader.sources[0]
		reader.sources = reader.sources[1:]

		output, err := reader.objects.client.GetObject(reader.ctx, &s3.GetObjectInput{
			Bucket: aws.String(reader.objects.bucket),
			Key:    aws.String(source.Key),
		})
		if err != nil {
			return 0, fmt.Errorf("read staged chunk: %w", err)
		}

		reader.current = output.Body
		reader.left = source.Length
	}

	read, err := reader.current.Read(buffer[:min(int64(len(buffer)), reader.left+1)])
	reader.hash.Write(buffer[:read])
	reader.left -= int64(read)

	switch {
	case reader.left < 0:
		return read, fmt.Errorf("staged chunk is longer than recorded: %w", ErrCorrupt)
	case errors.Is(err, io.EOF):
		_ = reader.current.Close()
		reader.current = nil

		if reader.left != 0 {
			return read, fmt.Errorf("staged chunk is shorter than recorded: %w", ErrCorrupt)
		}

		return read, nil
	case err != nil:
		return read, fmt.Errorf("read staged chunk: %w", err)
	}

	return read, nil
}

// finish checks that the sources are exhausted, with no trailing bytes, and
// verifies the digest.
func (reader *sourceReader) finish(verify func([]byte) error) error {
	var probe [1]byte

	for {
		read, err := reader.Read(probe[:])
		if read > 0 {
			return fmt.Errorf("staged chunks are longer than the blob: %w", ErrCorrupt)
		}

		if errors.Is(err, io.EOF) {
			break
		}

		if err != nil {
			return err
		}
	}

	if verify == nil {
		return nil
	}

	return verify(reader.hash.Sum(nil))
}

// DeletePrefix deletes up to budget objects whose keys start with prefix. It
// reports how many it deleted and whether none remain.
func (objects *Objects) DeletePrefix(ctx context.Context, prefix string, budget int) (int, bool, error) {
	deleted := 0

	for deleted < budget {
		listed, err := objects.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:  aws.String(objects.bucket),
			Prefix:  aws.String(prefix),
			MaxKeys: aws.Int32(int32(min(budget-deleted, deleteBatch))),
		})
		if err != nil {
			return deleted, false, fmt.Errorf("list objects: %w", err)
		}

		if len(listed.Contents) == 0 {
			return deleted, true, nil
		}

		identifiers := make([]types.ObjectIdentifier, 0, len(listed.Contents))
		for _, object := range listed.Contents {
			identifiers = append(identifiers, types.ObjectIdentifier{Key: object.Key})
		}

		output, err := objects.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(objects.bucket),
			Delete: &types.Delete{Objects: identifiers, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return deleted, false, fmt.Errorf("delete objects: %w", err)
		}

		// A key another process deleted meanwhile is gone, as wanted.
		var failed []types.Error

		for _, problem := range output.Errors {
			if aws.ToString(problem.Code) != "NoSuchKey" {
				failed = append(failed, problem)
			}
		}

		if len(failed) > 0 {
			return deleted, false, fmt.Errorf("delete objects: %d failed, first: %s: %s", len(failed),
				aws.ToString(failed[0].Code), aws.ToString(failed[0].Message))
		}

		deleted += len(identifiers)

		if !aws.ToBool(listed.IsTruncated) {
			return deleted, true, nil
		}
	}

	return deleted, false, nil
}

// multipartCursor resumes a listing of multipart uploads.
type multipartCursor struct {
	keyMarker      *string
	uploadIDMarker *string
}

// abortStaleMultipartUploads aborts multipart uploads under prefix that were
// initiated before cutoff and that spare (if not nil) does not keep, listing
// at most pages pages from cursor. It returns how many it aborted and where
// to continue (zero cursor: the listing wrapped around).
//
// Other processes may abort the same uploads concurrently: an upload that is
// already gone counts as done. A failure to check or abort one upload does
// not stop the others; the failures are returned together.
func (objects *Objects) abortStaleMultipartUploads(ctx context.Context, prefix string, cutoff time.Time, cursor multipartCursor, pages int, spare func(ctx context.Context, key string) (bool, error)) (int, multipartCursor, error) {
	aborted := 0

	var problems []error

	for range pages {
		listed, err := objects.client.ListMultipartUploads(ctx, &s3.ListMultipartUploadsInput{
			Bucket:         aws.String(objects.bucket),
			Prefix:         aws.String(prefix),
			KeyMarker:      cursor.keyMarker,
			UploadIdMarker: cursor.uploadIDMarker,
		})
		if err != nil {
			problems = append(problems, fmt.Errorf("list multipart uploads: %w", err))

			return aborted, cursor, errors.Join(problems...)
		}

		for _, upload := range listed.Uploads {
			if upload.Initiated == nil || !upload.Initiated.Before(cutoff) {
				continue
			}

			if spare != nil {
				spared, err := spare(ctx, aws.ToString(upload.Key))
				if err != nil {
					// Keep an upload whose status is unknown.
					problems = append(problems, err)

					continue
				}

				if spared {
					continue
				}
			}

			done, err := objects.abortMultipart(ctx, aws.ToString(upload.Key), aws.ToString(upload.UploadId))
			if err != nil {
				problems = append(problems, err)

				continue
			}

			if done {
				aborted++
			}
		}

		if !aws.ToBool(listed.IsTruncated) {
			return aborted, multipartCursor{}, errors.Join(problems...)
		}

		cursor = multipartCursor{keyMarker: listed.NextKeyMarker, uploadIDMarker: listed.NextUploadIdMarker}
	}

	return aborted, cursor, errors.Join(problems...)
}

// abortMultipart aborts one multipart upload. It reports false, without an
// error, if the upload was already gone (another process aborted or
// completed it).
func (objects *Objects) abortMultipart(ctx context.Context, key, uploadID string) (bool, error) {
	_, err := objects.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket: aws.String(objects.bucket), Key: aws.String(key), UploadId: aws.String(uploadID),
	})

	switch {
	case err == nil:
		return true, nil
	case isNotFound(err, "NoSuchUpload"):
		return false, nil
	default:
		return false, fmt.Errorf("abort multipart upload: %w", err)
	}
}

// isNotFound reports whether err is the S3 error code, or any 404 response.
func isNotFound(err error, code string) bool {
	var apiError smithy.APIError
	if errors.As(err, &apiError) && apiError.ErrorCode() == code {
		return true
	}

	var response *awshttp.ResponseError

	return errors.As(err, &response) && response.HTTPStatusCode() == http.StatusNotFound
}

// parseBlobKey returns the vault and blob id named by a blob object key
// (see BlobKey), or false if key is not one.
func parseBlobKey(key string) (uuid.UUID, []byte, bool) {
	rest, ok := strings.CutPrefix(key, "vaults/")
	if !ok {
		return uuid.Nil, nil, false
	}

	vault, blob, ok := strings.Cut(rest, "/blobs/")
	if !ok {
		return uuid.Nil, nil, false
	}

	vaultID, err := uuid.Parse(vault)
	if err != nil || vaultID.String() != vault {
		return uuid.Nil, nil, false
	}

	blobID, err := hex.DecodeString(blob)
	if err != nil || hex.EncodeToString(blobID) != blob || len(blobID) == 0 {
		return uuid.Nil, nil, false
	}

	return vaultID, blobID, true
}
