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
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/pathkey"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/vaultpath"
)

// Sync bounds.
const (
	// MaxPathBytes bounds a revision's path (UTF-8 bytes).
	MaxPathBytes = vaultpath.MaxBytes
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
	// AllowE2EE lets CommitRevision write to end-to-end encrypted vaults,
	// under the vault's current key epoch, with the plaintext vaults' path
	// rules. Test-only: until issue #39 defines E2EE paths and lifts the
	// CreateVault guard (SPEC.md §9.3), no production server sets it.
	AllowE2EE bool
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

	anchors, err := changesAnchors(request.Msg)
	if err != nil {
		return nil, err
	}

	limit := pageSize(request.Msg.GetPageSize(), DefaultChangesPageSize, service.maxChangesPageSize())

	changes, err := vault.ListChanges(ctx, int64(since), anchors, limit)
	if err != nil {
		return nil, service.internal(ctx, "cannot list changes", err)
	}

	return connect.NewResponse(changesPage(request.Header(), service.Limits.MaxResponseBytes, changes)), nil
}

// changesAnchors parses the anchors a ListChanges request asks the server
// to check (SPEC.md §6.1): since_anchor, empty (no check) or the 16 bytes of
// a Revision.anchor, and only with a nonzero since_seq, since seq zero is no
// revision; and own_commit_anchor, likewise, with own_commit_seq, which is
// above since_seq and given if and only if the anchor is. since_seq is at
// most MaxInt64.
func changesAnchors(request *vaultsyncv1.ListChangesRequest) ([]store.SeqAnchor, error) {
	since := request.GetSinceSeq()

	var anchors []store.SeqAnchor

	switch anchor := request.GetSinceAnchor(); {
	case len(anchor) == 0:
	case len(anchor) != len(uuid.UUID{}):
		return nil, invalidArgument("since_anchor must be empty or %d bytes", len(uuid.UUID{}))
	case since == 0:
		return nil, invalidArgument("since_anchor must be empty when since_seq is 0")
	default:
		anchors = append(anchors, store.SeqAnchor{Seq: int64(since), Anchor: uuid.UUID(anchor)})
	}

	switch seq, anchor := request.GetOwnCommitSeq(), request.GetOwnCommitAnchor(); {
	case seq == 0 && len(anchor) == 0:
	case len(anchor) != len(uuid.UUID{}):
		return nil, invalidArgument("own_commit_anchor must be %d bytes with own_commit_seq", len(uuid.UUID{}))
	case seq == 0:
		return nil, invalidArgument("own_commit_anchor must be empty when own_commit_seq is 0")
	case seq <= since:
		return nil, invalidArgument("own_commit_seq must be above since_seq")
	case seq > math.MaxInt64:
		return nil, invalidArgument("own_commit_seq must be at most %d", int64(math.MaxInt64))
	default:
		anchors = append(anchors, store.SeqAnchor{Seq: int64(seq), Anchor: uuid.UUID(anchor)})
	}

	return anchors, nil
}

// changesPage builds the ListChanges response for changes, for a request
// with header and a response limit of limitBytes (zero: unbounded).
func changesPage(header http.Header, limitBytes int, changes store.Changes) *vaultsyncv1.ListChangesResponse {
	response := &vaultsyncv1.ListChangesResponse{
		HasMore:  changes.HasMore,
		HeadSeq:  uint64(max(changes.HeadSeq, 0)),
		Diverged: changes.Diverged,
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

	// Each device is named once, with the first revision of the page it
	// committed, and charged to the budget with it.
	named := make(map[uuid.UUID]bool)

	for _, revision := range history.Revisions {
		message := revisionMessage(revision)
		entries := []proto.Message{message}

		name, known := history.DeviceNames[revision.DeviceID]

		var deviceName *vaultsyncv1.DeviceName
		if known && !named[revision.DeviceID] {
			deviceName = &vaultsyncv1.DeviceName{DeviceId: revision.DeviceID.String(), Name: name}
			entries = append(entries, deviceName)
		}

		if !budget.admit(entries...) {
			hasMore = true

			break
		}

		response.Revisions = append(response.Revisions, message)

		if deviceName != nil {
			named[revision.DeviceID] = true

			response.DeviceNames = append(response.DeviceNames, deviceName)
		}
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
	if encryption != store.EncryptionNone && !service.AllowE2EE {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("end-to-end encrypted vaults are not supported yet"))
	}

	// The store checks the epoch against the vault's current one under the
	// vault row lock; here only its form.
	epoch := request.Msg.GetEpoch()

	switch {
	case encryption == store.EncryptionNone && epoch != 0:
		return nil, invalidArgument("epoch must be 0 in a plaintext vault")
	case encryption != store.EncryptionNone && (epoch == 0 || epoch > math.MaxInt32):
		return nil, invalidArgument("epoch must be the vault's current key epoch (1 to %d)", math.MaxInt32)
	}

	revision.Epoch = int32(epoch) //nolint:gosec // checked against MaxInt32 above.

	if len(request.Msg.GetPathKey()) != 0 {
		return nil, invalidArgument("path_key must be empty for plaintext vaults; the server derives it from path")
	}

	revision.PathKey = pathkey.Key(revision.Path)
	if len(revision.PathKey) > MaxPathKeyBytes {
		return nil, invalidArgument("path is too long once normalized (at most %d bytes)", MaxPathKeyBytes)
	}

	committed, err := vault.CommitRevision(ctx, revision)
	if errors.Is(err, store.ErrPathNotCurrent) {
		// Name the rule the path breaks.
		return nil, invalidArgument("%w; only a live document already at this path may keep it "+
			"(edit or delete it in place, or rename it to a path that keeps the rules)", vaultpath.CheckNew(revision.Path))
	}

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
	case errors.Is(err, store.ErrEpochNotCurrent):
		return ReasonError(connect.CodeFailedPrecondition, vaultsyncv1.ErrorReason_ERROR_REASON_EPOCH_NOT_CURRENT,
			errors.New("epoch is not the vault's current key epoch; list the vault's epochs, encrypt under the current one and retry"))
	case errors.Is(err, store.ErrDeviceNotFound):
		return ReasonError(connect.CodeNotFound, vaultsyncv1.ErrorReason_ERROR_REASON_DEVICE_NOT_FOUND,
			errors.New("device not found: it was removed or is not yours; register this installation again"))
	case errors.Is(err, store.ErrRevisionConflict),
		errors.Is(err, store.ErrIDInUse),
		errors.Is(err, store.ErrKindMismatch),
		errors.Is(err, store.ErrBlobSizeMismatch),
		errors.Is(err, store.ErrContentKind),
		errors.Is(err, store.ErrInvalidPath),
		errors.Is(err, store.ErrPathNotCurrent):
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
	case vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER:
		revision.Kind = store.KindFolder
	case vaultsyncv1.DocumentKind_DOCUMENT_KIND_YJS:
		return store.NewRevision{}, invalidArgument("kind DOCUMENT_KIND_YJS is not supported yet")
	default:
		return store.NewRevision{}, invalidArgument("kind must be DOCUMENT_KIND_BLOB, DOCUMENT_KIND_TEXT or DOCUMENT_KIND_FOLDER")
	}

	content := message.GetContentRef()

	switch {
	case revision.Kind == store.KindFolder && content != nil:
		return store.NewRevision{}, invalidArgument("content_ref must be absent for DOCUMENT_KIND_FOLDER")
	case revision.Kind == store.KindFolder:
	case content == nil:
		return store.NewRevision{}, invalidArgument("content_ref is required")
	default:
		if err := checkBlobID(content.GetBlobId()); err != nil {
			return store.NewRevision{}, err
		}

		if content.GetSize() > math.MaxInt64 {
			return store.NewRevision{}, invalidArgument("content_ref.size is out of range")
		}

		revision.ContentRef = content.GetBlobId()
		revision.ContentSize = int64(content.GetSize())
	}

	if revision.Path, err = checkPath(message.GetPath()); err != nil {
		return store.NewRevision{}, err
	}

	// A vault-relative path that breaks a new-path rule (a "\", a drive-like
	// prefix such as "1:", or a name that is not portable) may not be given
	// to a document, but a document committed before those rules may keep it
	// (SPEC.md §6.2).
	revision.PathMustBeCurrent = errors.Is(vaultpath.CheckNew(revision.Path), vaultpath.ErrNotNew)

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
// bytes of UTF-8 without control characters (vaultpath.CheckText) that is
// vault-relative on every client platform (vaultpath.Check: "/" and "\" are
// both separators). Only the stricter vaultpath.CheckNew paths may be
// created; parseCommit marks the others.
func checkPath(path []byte) (string, error) {
	text := string(path)
	if err := vaultpath.CheckText(text); err != nil {
		return "", connect.NewError(connect.CodeInvalidArgument, err)
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
	case store.KindFolder:
		return vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER
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
		Anchor:     revision.Anchor[:],
		Epoch:      uint32(max(revision.Epoch, 0)),
	}

	if revision.ParentRevID.Valid {
		message.ParentRevId = revision.ParentRevID.UUID.String()
	}

	if revision.ContentRef != nil {
		message.ContentRef = &vaultsyncv1.ContentRef{BlobId: revision.ContentRef, Size: uint64(max(revision.ContentSize, 0))}
	}

	return message
}
