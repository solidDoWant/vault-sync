package api

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/pathkey"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/textcheck"
	"github.com/solidDoWant/vault-sync/internal/vaultpath"
)

// Sync bounds.
const (
	// MaxPathBytes bounds a revision's path (UTF-8 bytes).
	MaxPathBytes = 4096
	// MaxPathKeyBytes bounds a derived path_key; case folding can expand
	// a path.
	MaxPathKeyBytes = 8192
	// DefaultChangesPageSize is the ListChanges page size when none is
	// given.
	DefaultChangesPageSize = 500
	// MaxChangesPageSize caps the ListChanges page size.
	MaxChangesPageSize = 1000
	// DefaultHistoryPageSize is the GetDocumentHistory page size when none
	// is given.
	DefaultHistoryPageSize = 100
	// MaxHistoryPageSize caps the GetDocumentHistory page size.
	MaxHistoryPageSize = 1000
)

// SyncLimits caps page sizes. Zero fields select the Max*PageSize
// constants; tests lower them.
type SyncLimits struct {
	MaxChangesPageSize int
	MaxHistoryPageSize int
	// MaxResponseBytes bounds the encoded size of a ListChanges or
	// GetDocumentHistory response (see pageBudget). The server sets it to
	// its send limit; tests lower it. Zero leaves pages bounded by entry
	// count only.
	MaxResponseBytes int
}

// SyncService implements vaultsync.v1.SyncService (SPEC.md §6). Every
// procedure is vault-scoped: the authorization interceptor has resolved the
// caller's role before a handler runs, and handlers act only on the vault it
// authorized, through a vault-scoped store handle, so document and revision
// ids from another vault are simply not found. It keeps no state of its own:
// concurrent commits, on any number of server processes, are ordered by
// PostgreSQL.
type SyncService struct {
	Store  *store.Store
	Limits SyncLimits
	// Logger receives internal errors, which are not returned to callers.
	Logger *slog.Logger
}

var _ vaultsyncv1connect.SyncServiceHandler = SyncService{}

// vault returns the store handle of the vault the interceptor authorized.
// The request's vault_id is never used directly.
func (service SyncService) vault(ctx context.Context) (*store.VaultStore, error) {
	membership, ok := authz.MembershipFromContext(ctx)
	if !ok {
		service.Logger.ErrorContext(ctx, "sync procedure reached without an authorized vault")

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
	}

	return service.Store.InVault(membership.VaultID), nil
}

func (service SyncService) internal(ctx context.Context, message string, err error) error {
	service.Logger.ErrorContext(ctx, message, "error", err)

	return connect.NewError(connect.CodeInternal, errors.New(message))
}

func invalidArgument(format string, arguments ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(format, arguments...))
}

// pageSize applies the default and the server's cap to a requested size.
func pageSize(requested uint32, defaultSize, limit int) int {
	if requested == 0 {
		return min(defaultSize, limit)
	}

	return int(min(int64(requested), int64(limit)))
}

func (service SyncService) maxChangesPageSize() int {
	if service.Limits.MaxChangesPageSize > 0 {
		return service.Limits.MaxChangesPageSize
	}

	return MaxChangesPageSize
}

func (service SyncService) maxHistoryPageSize() int {
	if service.Limits.MaxHistoryPageSize > 0 {
		return service.Limits.MaxHistoryPageSize
	}

	return MaxHistoryPageSize
}

// ListChanges returns revisions after a vault-wide cursor.
func (service SyncService) ListChanges(ctx context.Context, request *connect.Request[vaultsyncv1.ListChangesRequest]) (*connect.Response[vaultsyncv1.ListChangesResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	since := request.Msg.GetSinceSeq()
	if since > math.MaxInt64 {
		return nil, invalidArgument("since_seq must be at most %d", int64(math.MaxInt64))
	}

	limit := pageSize(request.Msg.GetPageSize(), DefaultChangesPageSize, service.maxChangesPageSize())

	changes, err := vault.ListChanges(ctx, int64(since), limit)
	if err != nil {
		return nil, service.internal(ctx, "cannot list changes", err)
	}

	return connect.NewResponse(changesPage(request.Header(), service.Limits.MaxResponseBytes, changes)), nil
}

// changesPage builds the ListChanges response for changes, for a request
// with header and a response limit of limitBytes (zero: unbounded).
func changesPage(header http.Header, limitBytes int, changes store.Changes) *vaultsyncv1.ListChangesResponse {
	response := &vaultsyncv1.ListChangesResponse{
		HasMore: changes.HasMore,
		HeadSeq: uint64(max(changes.HeadSeq, 0)),
	}

	// The page also ends where its encoding would exceed the response
	// limit; the client continues from the last revision it got.
	budget := newPageBudget(header, limitBytes)

	for _, revision := range changes.Revisions {
		message := revisionMessage(revision)
		if !budget.admit(message) {
			response.HasMore = true

			break
		}

		response.Revisions = append(response.Revisions, message)
	}

	return response
}

// GetRevision returns one revision of the vault.
func (service SyncService) GetRevision(ctx context.Context, request *connect.Request[vaultsyncv1.GetRevisionRequest]) (*connect.Response[vaultsyncv1.GetRevisionResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	revisionID, err := authz.ParseID(request.Msg.GetRevisionId())
	if err != nil {
		return nil, invalidArgument("revision_id: %w", err)
	}

	revision, err := vault.Revision(ctx, revisionID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("revision not found"))
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot look up revision", err)
	}

	return connect.NewResponse(&vaultsyncv1.GetRevisionResponse{Revision: revisionMessage(revision)}), nil
}

// GetDocumentHistory pages through a document's revisions, newest first.
func (service SyncService) GetDocumentHistory(ctx context.Context, request *connect.Request[vaultsyncv1.GetDocumentHistoryRequest]) (*connect.Response[vaultsyncv1.GetDocumentHistoryResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	documentID, err := authz.ParseID(request.Msg.GetDocumentId())
	if err != nil {
		return nil, invalidArgument("document_id: %w", err)
	}

	before, err := decodeHistoryToken(request.Msg.GetPageToken())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	limit := pageSize(request.Msg.GetPageSize(), DefaultHistoryPageSize, service.maxHistoryPageSize())

	history, err := vault.DocumentHistory(ctx, documentID, before, limit)
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("document not found"))
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot list document history", err)
	}

	return connect.NewResponse(historyPage(request.Header(), service.Limits.MaxResponseBytes, history)), nil
}

// historyPage builds the GetDocumentHistory response for history, for a
// request with header and a response limit of limitBytes (zero:
// unbounded).
func historyPage(header http.Header, limitBytes int, history store.History) *vaultsyncv1.GetDocumentHistoryResponse {
	response := &vaultsyncv1.GetDocumentHistoryResponse{Document: documentMessage(history.Document)}

	// The page also ends where its encoding would exceed the response
	// limit; the token continues after the last revision returned.
	budget := newPageBudget(header, limitBytes)
	hasMore := history.HasMore

	for _, revision := range history.Revisions {
		message := revisionMessage(revision)
		if !budget.admit(message) {
			hasMore = true

			break
		}

		response.Revisions = append(response.Revisions, message)
	}

	if hasMore && len(response.Revisions) > 0 {
		response.NextPageToken = encodeHistoryToken(history.Revisions[len(response.Revisions)-1].Seq)
	}

	return response
}

// CommitRevision appends a revision with optimistic concurrency.
func (service SyncService) CommitRevision(ctx context.Context, request *connect.Request[vaultsyncv1.CommitRevisionRequest]) (*connect.Response[vaultsyncv1.CommitRevisionResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	revision, err := parseCommit(request.Msg)
	if err != nil {
		return nil, err
	}

	revision.UserID = user.ID

	encryption, err := vault.Encryption(ctx)
	if err != nil {
		return nil, service.internal(ctx, "cannot commit revision", err)
	}

	// End-to-end encrypted vaults cannot be created until key management
	// exists (SPEC.md §9.3); their path keys are client-computed HMACs and
	// their paths ciphertext, which this server does not accept yet.
	if encryption != store.EncryptionNone {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("end-to-end encrypted vaults are not supported yet"))
	}

	if len(request.Msg.GetPathKey()) != 0 {
		return nil, invalidArgument("path_key must be empty for plaintext vaults; the server derives it from path")
	}

	revision.PathKey = pathkey.Key(revision.Path)
	if len(revision.PathKey) > MaxPathKeyBytes {
		return nil, invalidArgument("path is too long once normalized (at most %d bytes)", MaxPathKeyBytes)
	}

	committed, err := vault.CommitRevision(ctx, revision)
	if err != nil {
		return nil, service.commitError(ctx, err)
	}

	return connect.NewResponse(&vaultsyncv1.CommitRevisionResponse{Revision: revisionMessage(committed)}), nil
}

func (service SyncService) commitError(ctx context.Context, err error) error {
	var headMoved *store.HeadMovedError
	if errors.As(err, &headMoved) {
		failed := connect.NewError(connect.CodeFailedPrecondition,
			errors.New("base_rev_id is not the document's head; pull, merge and retry with the current head (attached as a Document detail)"))

		if detail, detailErr := connect.NewErrorDetail(documentMessage(headMoved.Document)); detailErr == nil {
			failed.AddDetail(detail)
		}

		return failed
	}

	switch {
	case errors.Is(err, store.ErrDocumentNotFound):
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("the document does not exist; commit it with an empty base_rev_id"))
	case errors.Is(err, store.ErrBlobNotComplete):
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("content_ref is not a complete blob in this vault; upload it first"))
	case errors.Is(err, store.ErrPathKeyTaken):
		return connect.NewError(connect.CodeAlreadyExists, errors.New("another live document has this path (ignoring case and Unicode normalization)"))
	case errors.Is(err, store.ErrPathFolderTaken):
		return connect.NewError(connect.CodeAlreadyExists,
			errors.New("a live document's path is a folder of this path, or this path is a folder of a live document's (ignoring case and Unicode normalization)"))
	case errors.Is(err, store.ErrDeviceNotFound):
		return connect.NewError(connect.CodeNotFound, errors.New("device not found"))
	case errors.Is(err, store.ErrRevisionConflict),
		errors.Is(err, store.ErrIDInUse),
		errors.Is(err, store.ErrKindMismatch),
		errors.Is(err, store.ErrBlobSizeMismatch),
		errors.Is(err, store.ErrInvalidPath):
		return connect.NewError(connect.CodeInvalidArgument, err)
	default:
		return service.internal(ctx, "cannot commit revision", err)
	}
}

// parseCommit validates a CommitRevisionRequest's fields, except path_key,
// which depends on the vault's encryption.
func parseCommit(message *vaultsyncv1.CommitRevisionRequest) (store.NewRevision, error) {
	var revision store.NewRevision

	var err error

	if revision.DocumentID, err = parseClientID(message.GetDocumentId()); err != nil {
		return store.NewRevision{}, invalidArgument("document_id: %w", err)
	}

	if revision.ID, err = parseClientID(message.GetRevisionId()); err != nil {
		return store.NewRevision{}, invalidArgument("revision_id: %w", err)
	}

	if base := message.GetBaseRevId(); base != "" {
		id, err := authz.ParseID(base)
		if err != nil {
			return store.NewRevision{}, invalidArgument("base_rev_id: %w", err)
		}

		revision.BaseRevID = uuid.NullUUID{UUID: id, Valid: true}
	}

	if revision.DeviceID, err = authz.ParseID(message.GetDeviceId()); err != nil {
		return store.NewRevision{}, invalidArgument("device_id: %w", err)
	}

	switch message.GetKind() {
	case vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB:
		revision.Kind = kindBlob
	case vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT:
		revision.Kind = kindText
	case vaultsyncv1.DocumentKind_DOCUMENT_KIND_YJS:
		return store.NewRevision{}, invalidArgument("kind DOCUMENT_KIND_YJS is not supported yet")
	default:
		return store.NewRevision{}, invalidArgument("kind must be DOCUMENT_KIND_BLOB or DOCUMENT_KIND_TEXT")
	}

	content := message.GetContentRef()
	if content == nil {
		return store.NewRevision{}, invalidArgument("content_ref is required")
	}

	if err := checkBlobID(content.GetBlobId()); err != nil {
		return store.NewRevision{}, err
	}

	if content.GetSize() > math.MaxInt64 {
		return store.NewRevision{}, invalidArgument("content_ref.size is out of range")
	}

	revision.ContentRef = content.GetBlobId()
	revision.ContentSize = int64(content.GetSize())

	if revision.Path, err = checkPath(message.GetPath()); err != nil {
		return store.NewRevision{}, err
	}

	revision.Deleted = message.GetDeleted()

	return revision, nil
}

// parseClientID parses a client-generated id, which must be a canonical
// UUIDv7 (SPEC.md §5).
func parseClientID(value string) (uuid.UUID, error) {
	id, err := authz.ParseID(value)
	if err != nil {
		return uuid.Nil, err
	}

	if id.Version() != 7 {
		return uuid.Nil, errors.New("not a UUIDv7")
	}

	return id, nil
}

// checkPath validates a plaintext vault-relative path: 1 to MaxPathBytes
// bytes of UTF-8 without control characters that is vault-relative on every
// client platform (vaultpath.Check: "/" and "\" are both separators).
func checkPath(path []byte) (string, error) {
	if len(path) == 0 || len(path) > MaxPathBytes {
		return "", invalidArgument("path must be 1 to %d bytes", MaxPathBytes)
	}

	text := string(path)
	if !textcheck.Printable(text) {
		return "", invalidArgument("path must be valid UTF-8 without control characters")
	}

	if err := vaultpath.Check(text); err != nil {
		return "", connect.NewError(connect.CodeInvalidArgument, err)
	}

	return text, nil
}

// historyTokenEncoding encodes GetDocumentHistory page tokens: the seq of
// the last (oldest) revision on the previous page.
var historyTokenEncoding = base64.RawURLEncoding

func encodeHistoryToken(seq int64) string {
	return historyTokenEncoding.EncodeToString(binary.BigEndian.AppendUint64(nil, uint64(seq)))
}

// decodeHistoryToken returns the exclusive upper seq bound a token encodes,
// or zero for no token.
func decodeHistoryToken(token string) (int64, error) {
	if token == "" {
		return 0, nil
	}

	invalid := errors.New("page_token is not a token returned by GetDocumentHistory")

	if len(token) != historyTokenEncoding.EncodedLen(8) {
		return 0, invalid
	}

	decoded, err := historyTokenEncoding.DecodeString(token)
	if err != nil {
		return 0, invalid
	}

	seq := binary.BigEndian.Uint64(decoded)
	if seq == 0 || seq > math.MaxInt64 {
		return 0, invalid
	}

	return int64(seq), nil
}

// Document kinds, as stored in documents.kind.
const (
	kindBlob = "blob"
	kindText = "text"
	kindYjs  = "yjs"
)

func kindMessage(kind string) vaultsyncv1.DocumentKind {
	switch kind {
	case kindBlob:
		return vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB
	case kindText:
		return vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT
	case kindYjs:
		return vaultsyncv1.DocumentKind_DOCUMENT_KIND_YJS
	default:
		return vaultsyncv1.DocumentKind_DOCUMENT_KIND_UNSPECIFIED
	}
}

func documentMessage(document store.Document) *vaultsyncv1.Document {
	return &vaultsyncv1.Document{
		Id:        document.ID.String(),
		VaultId:   document.VaultID.String(),
		Kind:      kindMessage(document.Kind),
		HeadRevId: document.HeadRevID.String(),
	}
}

func revisionMessage(revision store.Revision) *vaultsyncv1.Revision {
	message := &vaultsyncv1.Revision{
		Id:         revision.ID.String(),
		DocumentId: revision.DocumentID.String(),
		VaultId:    revision.VaultID.String(),
		Seq:        uint64(max(revision.Seq, 0)),
		Kind:       kindMessage(revision.Kind),
		Path:       []byte(revision.Path),
		Deleted:    revision.Deleted,
		DeviceId:   revision.DeviceID.String(),
		UserId:     revision.UserID.String(),
		CreateTime: timestamppb.New(revision.CreatedAt),
	}

	if revision.ParentRevID.Valid {
		message.ParentRevId = revision.ParentRevID.UUID.String()
	}

	if revision.ContentRef != nil {
		message.ContentRef = &vaultsyncv1.ContentRef{BlobId: revision.ContentRef, Size: uint64(max(revision.ContentSize, 0))}
	}

	return message
}
