package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Blob bounds.
const (
	// BlobIDBytes is the length of a blob id: a SHA-256 or HMAC-SHA256
	// digest (SPEC.md §5).
	BlobIDBytes = 32
	// ChunkReserveBytes is reserved in every PutBlobChunk request and
	// DownloadBlob response for the fields besides the chunk's data (a
	// vault id, a blob id, an offset or size, and their framing take under
	// 200 bytes in either codec), so a maximum-size chunk always fits the
	// message limit.
	ChunkReserveBytes = 1 << 10
	// cleanupTimeout bounds the immediate removal of a finished upload's
	// staged objects; whatever it leaves, the cleanup routine removes.
	cleanupTimeout = 30 * time.Second
)

// BlobLimits bounds blob uploads and downloads.
type BlobLimits struct {
	// MaxChunkBytes is the largest PutBlobChunk payload and the largest
	// DownloadBlob response payload.
	MaxChunkBytes int64
	// MaxMessageBytes is the server's request and send limit (zero:
	// unbounded); the server sets it. A JSON client's chunks and ranges are
	// cut so their base64 encoding fits it (see chunkLimit).
	MaxMessageBytes int64
	// MaxBlobBytes is the largest blob.
	MaxBlobBytes int64
	// MaxUploadsPerVault bounds the active upload sessions in one vault.
	MaxUploadsPerVault int
	// UploadReclaimIdle is how long a session must be idle before a
	// BeginBlob in a vault at MaxUploadsPerVault reclaims it; zero never
	// reclaims.
	UploadReclaimIdle time.Duration
}

// BlobService implements vaultsync.v1.BlobService (SPEC.md §6.2). Every
// procedure is vault-scoped: the authorization interceptor has resolved the
// caller's role before a handler runs, and handlers act only on the vault it
// authorized, through a vault-scoped store handle, so a blob id from another
// vault is simply not found.
type BlobService struct {
	Store   *store.Store
	Objects *blobstore.Objects
	Limits  BlobLimits
	// Logger receives internal errors, which are not returned to callers.
	Logger *slog.Logger
}

var _ vaultsyncv1connect.BlobServiceHandler = BlobService{}

// vault returns the store handle of the vault the interceptor authorized.
// The request's vault_id is never used directly.
func (service BlobService) vault(ctx context.Context) (*store.VaultStore, error) {
	membership, ok := authz.MembershipFromContext(ctx)
	if !ok {
		service.Logger.ErrorContext(ctx, "blob procedure reached without an authorized vault")

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
	}

	return service.Store.InVault(membership.VaultID), nil
}

func checkBlobID(blobID []byte) error {
	if len(blobID) != BlobIDBytes {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("blob_id must be %d bytes", BlobIDBytes))
	}

	return nil
}

func (service BlobService) internal(ctx context.Context, message string, err error) error {
	service.Logger.ErrorContext(ctx, message, "error", err)

	return connect.NewError(connect.CodeInternal, errors.New(message))
}

// chunkLimit returns the largest chunk a request may upload, and the largest
// range a response may carry, in the request's codec. In binary protobuf it
// is MaxChunkBytes, which startup checks fits the message limit with
// ChunkReserveBytes to spare. protobuf JSON encodes bytes in base64, four
// characters for every three bytes, so a JSON chunk is cut to what fits the
// message limit once encoded, keeping the same reserve and room for gzip
// framing (as pageBudget does for pages of revisions). The limit depends
// only on the request, so every replica agrees on it.
func (service BlobService) chunkLimit(header http.Header) int64 {
	limit := service.Limits.MaxChunkBytes

	messageBytes := service.Limits.MaxMessageBytes
	if messageBytes <= 0 || !isJSONContentType(header.Get("Content-Type")) {
		return limit
	}

	budget := messageBytes - messageBytes/1000 - ChunkReserveBytes

	return max(min(limit, budget/4*3), 1)
}

// rangeLimit returns the largest range a DownloadBlob response may carry in
// the request's codec: chunkLimit, and in binary protobuf no more than fits
// the send limit once gzip has framed it. The send limit applies to the
// compressed response, and deflate makes incompressible (for example E2EE)
// content slightly larger: a few bytes per block, under a thousandth of the
// message, which the binary chunk's reserve alone does not cover at large
// limits. Half the reserve stays for the other fields (under 200 bytes) and
// the gzip header and trailer, so at the default and smallest limits a
// binary range is still MaxChunkBytes. JSON chunks already leave room for
// gzip framing (see chunkLimit).
func (service BlobService) rangeLimit(header http.Header) int64 {
	limit := service.chunkLimit(header)

	messageBytes := service.Limits.MaxMessageBytes
	if messageBytes <= 0 || isJSONContentType(header.Get("Content-Type")) {
		return limit
	}

	return max(min(limit, messageBytes-messageBytes/1000-ChunkReserveBytes/2), 1)
}

func maxChunkSize(limit int64) uint32 {
	return uint32(min(limit, int64(^uint32(0))))
}

// BeginBlob starts or resumes an upload, or reports the blob complete.
func (service BlobService) BeginBlob(ctx context.Context, request *connect.Request[vaultsyncv1.BeginBlobRequest]) (*connect.Response[vaultsyncv1.BeginBlobResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	blobID := request.Msg.GetBlobId()
	if err := checkBlobID(blobID); err != nil {
		return nil, err
	}

	size := request.Msg.GetSize()
	if size > uint64(service.Limits.MaxBlobBytes) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("size must be at most %d bytes", service.Limits.MaxBlobBytes))
	}

	start, err := vault.BeginBlobUpload(ctx, blobID, int64(size), service.Limits.MaxUploadsPerVault, service.Limits.UploadReclaimIdle)
	if errors.Is(err, store.ErrBlobUploadLimit) {
		return nil, connect.NewError(connect.CodeResourceExhausted,
			fmt.Errorf("at most %d uploads may be in progress in a vault; retry later", service.Limits.MaxUploadsPerVault))
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot begin blob upload", err)
	}

	response := &vaultsyncv1.BeginBlobResponse{MaxChunkSize: maxChunkSize(service.chunkLimit(request.Header()))}

	if start.Complete {
		response.Complete = true
		response.ReceivedSize = uint64(start.CompleteSize)

		return connect.NewResponse(response), nil
	}

	if start.Upload.Size != int64(size) {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("size differs from the upload of this blob in progress (%d bytes)", start.Upload.Size))
	}

	response.ReceivedSize = uint64(start.Upload.ReceivedSize)

	return connect.NewResponse(response), nil
}

// PutBlobChunk appends one chunk to an upload in progress.
func (service BlobService) PutBlobChunk(ctx context.Context, request *connect.Request[vaultsyncv1.PutBlobChunkRequest]) (*connect.Response[vaultsyncv1.PutBlobChunkResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	blobID := request.Msg.GetBlobId()
	if err := checkBlobID(blobID); err != nil {
		return nil, err
	}

	data := request.Msg.GetData()
	if len(data) == 0 || int64(len(data)) > service.Limits.MaxChunkBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("data must be 1 to %d bytes", service.Limits.MaxChunkBytes))
	}

	upload, err := vault.ActiveBlobUpload(ctx, blobID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("no upload of this blob is in progress; call BeginBlob"))
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot look up blob upload", err)
	}

	offset := request.Msg.GetOffset()
	if offset != uint64(upload.ReceivedSize) {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("offset must equal the bytes received so far (%d); call BeginBlob to resume", upload.ReceivedSize))
	}

	end := upload.ReceivedSize + int64(len(data))
	if end > upload.Size {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunk extends past the declared size (%d bytes)", upload.Size))
	}

	// A JSON client's chunks may be smaller than MinChunkBytes when the
	// message limit is low; the minimum follows what it was advertised.
	if minimum := min(blobstore.MinChunkBytes, service.chunkLimit(request.Header())); end < upload.Size && int64(len(data)) < minimum {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("every chunk but the last must be at least %d bytes", minimum))
	}

	chunk := store.BlobChunk{Offset: upload.ReceivedSize, Length: int64(len(data)), Token: uuid.New()}
	key := blobstore.ChunkKey(upload.VaultID, upload.ID, chunk.Offset, chunk.Token)

	if err := service.Objects.Put(ctx, key, data); err != nil {
		return nil, service.internal(ctx, "cannot store chunk", err)
	}

	received, err := vault.AppendBlobChunk(ctx, upload.ID, chunk)
	if err != nil {
		// Not accepted: remove the staged object (the cleanup routine
		// removes it with its session if this fails).
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()

		_ = service.Objects.Delete(cleanupCtx, key)

		if errors.Is(err, store.ErrBlobUploadConflict) {
			return nil, connect.NewError(connect.CodeFailedPrecondition,
				errors.New("the upload changed concurrently; call BeginBlob to resume"))
		}

		return nil, service.internal(ctx, "cannot record chunk", err)
	}

	return connect.NewResponse(&vaultsyncv1.PutBlobChunkResponse{ReceivedSize: uint64(received)}), nil
}

// CommitBlob verifies and completes an upload.
func (service BlobService) CommitBlob(ctx context.Context, request *connect.Request[vaultsyncv1.CommitBlobRequest]) (*connect.Response[vaultsyncv1.CommitBlobResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	blobID := request.Msg.GetBlobId()
	if err := checkBlobID(blobID); err != nil {
		return nil, err
	}

	// One commit of a blob at a time on this replica: a duplicate (a retry
	// of a slow commit, or another device committing the same content)
	// waits for the commit in progress, holding no compose slot, and then
	// finds the blob complete instead of composing it again (SPEC.md §6.2).
	key := blobstore.BlobKey(vault.VaultID(), blobID)

	release, err := service.Objects.ClaimCompose(ctx, key)
	if err != nil {
		return nil, err
	}

	defer release()

	if response, err := service.alreadyComplete(ctx, vault, blobID); response != nil || err != nil {
		return response, err
	}

	upload, err := vault.ActiveBlobUpload(ctx, blobID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("no upload of this blob is in progress"))
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot look up blob upload", err)
	}

	if upload.ReceivedSize < upload.Size {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("only %d of %d bytes were received", upload.ReceivedSize, upload.Size))
	}

	// Compositions are shared fairly between users (the owner). Every
	// production path is authenticated, so a commit without a user is a
	// wiring bug, not a caller to put in a shared bucket.
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		service.Logger.ErrorContext(ctx, "blob commit reached without an authenticated user")

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
	}

	encryption, err := vault.Encryption(ctx)
	if err != nil {
		return nil, service.internal(ctx, "cannot commit blob", err)
	}

	// Plaintext vaults are content-addressed by SHA-256, which the server
	// verifies. In end-to-end encrypted vaults the id is an HMAC of the
	// plaintext the server never sees, so clients verify it after
	// decryption (SPEC.md §5).
	var verify func(sum []byte) error
	if encryption != store.EncryptionE2EE {
		verify = func(sum []byte) error {
			if !bytes.Equal(sum, blobID) {
				return blobstore.ErrHashMismatch
			}

			return nil
		}
	}

	progress := func(ctx context.Context) error { return vault.TouchBlobUpload(ctx, upload.ID) }

	// The garbage collector may be deleting an earlier object of this blob
	// (SPEC.md §11). Once that is done, a deletion that starts later sees
	// this upload in progress and leaves the object alone.
	if err := vault.AwaitBlobDeletion(ctx, blobID); err != nil {
		return nil, service.internal(ctx, "cannot commit blob", err)
	}

	// ActiveBlobUpload recorded activity, and composing records activity
	// while it waits for a compose slot and again after every part, so no
	// server process's cleanup routine reaps the session, or aborts its
	// multipart upload, while it is composed, however long that takes. The
	// staged chunks are listed only once the commit holds its slots, so a
	// waiting commit holds no list of them.
	var chunks int

	sources := func(ctx context.Context) ([]blobstore.Part, error) {
		parts, err := service.sources(ctx, vault, upload)
		chunks = len(parts)

		return parts, err
	}

	err = service.Objects.Compose(ctx, user.ID.String(), key, sources, upload.Size, verify, progress)
	if errors.Is(err, blobstore.ErrHashMismatch) {
		if err := vault.FinishBlobUpload(ctx, upload.ID); err != nil {
			return nil, service.internal(ctx, "cannot discard blob upload", err)
		}

		service.removeUpload(ctx, vault, upload.ID, chunks)

		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("the uploaded content does not match blob_id; the upload was discarded"))
	}

	if err != nil {
		// A concurrent commit of the same upload may have completed the
		// blob and removed the staged chunks this one was reading.
		if response, completeErr := service.alreadyComplete(ctx, vault, blobID); response != nil {
			return response, nil
		} else if completeErr != nil {
			return nil, completeErr
		}

		// Discarded or reaped meanwhile, which only happens to a session
		// idle for longer than the upload TTL. Composing notices that when
		// it reports progress, or earlier, by failing to read a staged
		// chunk the cleanup routine deleted while a part was read. The
		// cleanup routine of any server process claims a session in
		// PostgreSQL before it deletes any of its staged objects, so the
		// session is then no longer active. (Checking records activity on
		// a session that is still active, which the client may retry.)
		if errors.Is(err, store.ErrBlobUploadConflict) ||
			errors.Is(vault.TouchBlobUpload(ctx, upload.ID), store.ErrBlobUploadConflict) {
			return nil, connect.NewError(connect.CodeFailedPrecondition,
				errors.New("the upload is no longer in progress; call BeginBlob"))
		}

		return nil, service.internal(ctx, "cannot compose blob", err)
	}

	if err := vault.CompleteBlobUpload(ctx, upload.ID, blobID, upload.Size); err != nil {
		return nil, service.internal(ctx, "cannot complete blob", err)
	}

	service.removeUpload(ctx, vault, upload.ID, chunks)

	return connect.NewResponse(&vaultsyncv1.CommitBlobResponse{Size: uint64(upload.Size)}), nil
}

// alreadyComplete returns a CommitBlob response if blobID is complete.
func (service BlobService) alreadyComplete(ctx context.Context, vault *store.VaultStore, blobID []byte) (*connect.Response[vaultsyncv1.CommitBlobResponse], error) {
	blob, err := vault.CompleteBlob(ctx, blobID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot look up blob", err)
	}

	return connect.NewResponse(&vaultsyncv1.CommitBlobResponse{Size: uint64(blob.Size)}), nil
}

// sources lists the staged chunks of a fully received upload, checking that
// they cover it exactly.
func (service BlobService) sources(ctx context.Context, vault *store.VaultStore, upload store.BlobUpload) ([]blobstore.Part, error) {
	chunks, err := vault.BlobUploadChunks(ctx, upload.ID)
	if err != nil {
		return nil, err
	}

	sources := make([]blobstore.Part, 0, len(chunks))

	var next int64

	for _, chunk := range chunks {
		if chunk.Offset != next {
			return nil, fmt.Errorf("upload %s: chunk at %d, expected %d", upload.ID, chunk.Offset, next)
		}

		sources = append(sources, blobstore.Part{
			Key:    blobstore.ChunkKey(upload.VaultID, upload.ID, chunk.Offset, chunk.Token),
			Length: chunk.Length,
		})
		next += chunk.Length
	}

	if next != upload.Size {
		return nil, fmt.Errorf("upload %s: chunks cover %d of %d bytes", upload.ID, next, upload.Size)
	}

	return sources, nil
}

// removeUpload removes a finished upload's staged objects and session now,
// rather than waiting for the cleanup routine, which retries any failure.
func (service BlobService) removeUpload(ctx context.Context, vault *store.VaultStore, uploadID uuid.UUID, chunks int) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()

	// Leave room for chunks written by writers that lost a race.
	if _, _, err := blobstore.RemoveFinishedUpload(ctx, vault, service.Objects, uploadID, chunks+1000); err != nil {
		service.Logger.WarnContext(ctx, "cannot remove finished blob upload now; the cleanup routine will", "error", err)
	}
}

// DownloadBlob returns a byte range of a complete blob.
func (service BlobService) DownloadBlob(ctx context.Context, request *connect.Request[vaultsyncv1.DownloadBlobRequest]) (*connect.Response[vaultsyncv1.DownloadBlobResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	blobID := request.Msg.GetBlobId()
	if err := checkBlobID(blobID); err != nil {
		return nil, err
	}

	blob, err := vault.CompleteBlob(ctx, blobID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("blob not found"))
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot look up blob", err)
	}

	offset := request.Msg.GetOffset()
	if offset > uint64(blob.Size) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("offset is beyond the blob's size (%d bytes)", blob.Size))
	}

	// The response is bounded by the server, in the request's codec,
	// whatever the client asks for; a client continues from the end of a
	// short range.
	maxLength := service.rangeLimit(request.Header())

	length := int64(request.Msg.GetLength())
	if length == 0 || length > maxLength {
		length = maxLength
	}

	length = min(length, blob.Size-int64(offset))

	data, err := service.Objects.ReadRange(ctx, blobstore.BlobKey(blob.VaultID, blobID), int64(offset), length)
	if err != nil {
		return nil, service.internal(ctx, "cannot read blob", err)
	}

	return connect.NewResponse(&vaultsyncv1.DownloadBlobResponse{Data: data, Size: uint64(blob.Size)}), nil
}
