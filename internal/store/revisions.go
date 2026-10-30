package store

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// CommitRevision errors. Each names a reason the commit was refused; nothing
// was written.
var (
	// ErrRevisionConflict: the revision id was already committed in this
	// vault with different fields.
	ErrRevisionConflict = errors.New("revision_id was already committed with different fields")
	// ErrIDInUse: the document or revision id is taken outside this vault.
	ErrIDInUse = errors.New("id is already in use")
	// ErrDeviceNotFound: the device does not belong to the committing user,
	// or it was removed.
	ErrDeviceNotFound = errors.New("device not found")
	// ErrDocumentNotFound: a base revision was given for a document that
	// does not exist in this vault.
	ErrDocumentNotFound = errors.New("document not found")
	// ErrKindMismatch: the kind differs from the existing document's.
	ErrKindMismatch = errors.New("kind differs from the document's kind")
	// ErrBlobNotComplete: the content is not a complete blob in this vault.
	ErrBlobNotComplete = errors.New("content is not a complete blob in this vault")
	// ErrBlobSizeMismatch: the claimed content size differs from the
	// stored blob's size.
	ErrBlobSizeMismatch = errors.New("content size differs from the stored blob's size")
	// ErrContentKind: a folder revision has content, or a revision of any
	// other kind has none.
	ErrContentKind = errors.New("a folder has no content and every other kind has content")
	// ErrPathKeyTaken: another live document in the vault has the path key.
	ErrPathKeyTaken = errors.New("path_key is taken by another live document")
	// ErrPathFolderTaken: another live document's path_key is a folder of
	// the path key, or the path key is a folder of another live
	// document's (SPEC.md §5): a file and a folder cannot share a name.
	ErrPathFolderTaken = errors.New("path_key is a folder of another live document's, or lies under one")
	// ErrInvalidPath: the path or path key is empty, longer than the
	// schema allows (SPEC.md §5), or text PostgreSQL cannot store.
	ErrInvalidPath = errors.New("path or path_key is empty, too long, or not valid UTF-8 without NUL")
	// ErrPathNotCurrent: the revision's path may only be kept, not given
	// (NewRevision.PathMustBeCurrent), and the document is new, a
	// tombstone, or at another path.
	ErrPathNotCurrent = errors.New(`the path breaks a rule for new paths; ` +
		`only a live document already at such a path may keep it (edit or delete it in place, or rename it to a path that keeps the rules)`)
	// ErrEpochNotCurrent: the revision's epoch is not the vault's current
	// key epoch (SPEC.md §9.3). Also returned by an epoch change whose
	// expected epoch is not the current one.
	ErrEpochNotCurrent = errors.New("epoch is not the vault's current key epoch")
	// ErrReadOnlyMember: the committing user is a viewer of the vault.
	// A user who is not a member gets ErrVaultNotFound, and a member of a
	// deleted vault ErrVaultDeleted, as from VaultRole.
	ErrReadOnlyMember = errors.New("viewers cannot write to this vault")
)

// HeadMovedError is returned when a commit's base is not the document's
// current head (optimistic concurrency, SPEC.md §6.2). Document is the
// document as it is now.
type HeadMovedError struct {
	Document Document
}

func (err *HeadMovedError) Error() string {
	return "base revision is not the document's head"
}

// NewRevision is a revision to commit. Ids are client-generated.
type NewRevision struct {
	ID         uuid.UUID
	DocumentID uuid.UUID
	// BaseRevID is the document's head the revision is based on; invalid
	// (null) for a new document.
	BaseRevID uuid.NullUUID
	Kind      string
	// ContentRef is the content's blob id and ContentSize its size as
	// claimed by the client, which must equal the stored blob's size.
	ContentRef  []byte
	ContentSize int64
	// Path is the revision's path and PathKey its document's path key: a
	// plaintext path and its normalized form at epoch 0, ciphertext and a
	// client-computed HMAC (any bytes) at a later epoch (SPEC.md §9.3).
	Path    string
	PathKey string
	Deleted bool
	// PathMustBeCurrent accepts Path only as the unchanged path of the
	// document's live head (an edit or a delete in place), never for a new
	// document, a rename or a resurrection: ErrPathNotCurrent otherwise.
	// Set for paths that a commit may no longer create but that documents
	// committed before the rules may still hold (SPEC.md §6.2, #191, #148).
	PathMustBeCurrent bool
	DeviceID          uuid.UUID
	// UserID is the committing user; DeviceID must belong to them.
	UserID uuid.UUID
	// Epoch is the vault key epoch the revision is encrypted under: the
	// vault's current epoch (at least 1) in an E2EE vault, 0 in a
	// plaintext vault. Anything else is ErrEpochNotCurrent.
	Epoch int32
}

// KindFolder is the stored kind of a folder document, which has a path and
// no content (SPEC.md §5).
const KindFolder = "folder"

// livePathKeyIndex enforces path_key uniqueness among live documents.
const livePathKeyIndex = "documents_live_path_key_idx"

// idConstraints are the unique constraints on client-generated ids.
var idConstraints = map[string]bool{
	"documents_pkey":               true,
	"documents_id_vault_id_key":    true,
	"revisions_pkey":               true,
	"revisions_id_document_id_key": true,
}

// CommitRevision appends revision to its document with optimistic
// concurrency (SPEC.md §6.2) and returns the committed revision with its
// seq. It is idempotent by revision id: if the id was already committed in
// this vault with the same fields, that revision is returned (whatever the
// document's head is now); with different fields, ErrRevisionConflict.
//
// Otherwise the commit is accepted only if BaseRevID is the document's head
// (*HeadMovedError if not), or the document does not exist in this vault and
// BaseRevID is null (ErrDocumentNotFound if a base was given). The content
// must be a complete blob in this vault of the claimed size. The revision is
// assigned the vault's next seq, and the document's head, path key and
// tombstone flag are updated, all in one transaction.
//
// Every commit to a vault locks the vault row first and holds it until it
// commits, so commits to one vault are serialized by PostgreSQL across all
// server processes: seqs are gapless, and a revision becomes visible only
// after every revision with a lower seq.
//
// A new revision queues a VaultChangedChannel notification in the same
// transaction, which PostgreSQL delivers to every listener once it commits.
// An idempotent retry notifies nothing: the head did not move.
func (vault *VaultStore) CommitRevision(ctx context.Context, revision NewRevision) (Revision, error) {
	var committed Revision

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		var err error

		committed, err = vault.commitRevision(ctx, tx, revision)

		return err
	})
	if err != nil {
		return Revision{}, commitError(err)
	}

	return committed, nil
}

// lockDevice checks that deviceID is userID's and not removed, and holds
// its row lock until the commit ends. RemoveDevice updates the same row, so
// it waits for every commit in flight, and a commit that starts after it
// sees the removal: removal takes effect on every server process with
// PostgreSQL as the only coordination. The lock is taken after the vault
// row's, and nothing locks a device row before a vault row, so no deadlock
// arises; it serializes only one device's commits to different vaults. It
// also refreshes the device's last_seen, at most once per
// deviceLastSeenGranularity.
func lockDevice(ctx context.Context, tx pgx.Tx, deviceID, userID uuid.UUID) error {
	var stale bool

	err := tx.QueryRow(ctx, `
		SELECT last_seen IS NULL OR last_seen < now() - $3::interval FROM devices
		WHERE id = $1 AND user_id = $2 AND removed_at IS NULL
		FOR NO KEY UPDATE`, deviceID, userID, deviceLastSeenGranularity).Scan(&stale)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrDeviceNotFound
	}

	if err != nil {
		return fmt.Errorf("lock device: %w", err)
	}

	if !stale {
		return nil
	}

	if _, err := tx.Exec(ctx, `UPDATE devices SET last_seen = now() WHERE id = $1`, deviceID); err != nil {
		return fmt.Errorf("record device activity: %w", err)
	}

	return nil
}

// checkWriter returns nil if userID is an owner or editor of vaultID and the
// vault is not deleted: ErrVaultNotFound if they are not a member,
// ErrVaultDeleted if the vault is deleted, ErrReadOnlyMember if they are a
// viewer. It runs under the vault row lock, which every membership change
// and DeleteVault take too, in a statement of its own: at READ COMMITTED it
// sees every such change that committed while the commit waited for the
// lock. The caller's role was checked before the commit started (authz),
// but a removal, demotion or deletion may have committed since, and no
// commit is applied after it.
func checkWriter(ctx context.Context, tx pgx.Tx, vaultID, userID uuid.UUID) error {
	var (
		role    *Role
		deleted bool
	)

	err := tx.QueryRow(ctx, `
		SELECT (SELECT role FROM vault_members WHERE vault_id = $1 AND user_id = $2),
		       deleted_at IS NOT NULL
		FROM vaults WHERE id = $1`, vaultID, userID).Scan(&role, &deleted)
	if err != nil {
		return fmt.Errorf("look up committing member: %w", err)
	}

	switch {
	case role == nil:
		return ErrVaultNotFound
	case deleted:
		return ErrVaultDeleted
	case *role == RoleViewer:
		return ErrReadOnlyMember
	default:
		return nil
	}
}

func (vault *VaultStore) commitRevision(ctx context.Context, tx pgx.Tx, revision NewRevision) (Revision, error) {
	// NO KEY UPDATE, like BeginBlobUpload: inserts referencing the vault
	// take KEY SHARE locks on it and must not be blocked.
	var encryption Encryption

	var (
		currentEpoch int32
		converted    bool
	)

	err := tx.QueryRow(ctx, `
		SELECT encryption, current_epoch, conversion_seq IS NOT NULL FROM vaults WHERE id = $1 FOR NO KEY UPDATE`, vault.vaultID).
		Scan(&encryption, &currentEpoch, &converted)
	if err != nil {
		return Revision{}, notFound(err, "lock vault")
	}

	if err := checkWriter(ctx, tx, vault.vaultID, revision.UserID); err != nil {
		return Revision{}, err
	}

	if err := lockDevice(ctx, tx, revision.DeviceID, revision.UserID); err != nil {
		return Revision{}, err
	}

	// Idempotency comes before the head comparison: a retry whose first
	// attempt was applied (and whose response was lost) must get that
	// revision back even if other commits moved the head since.
	existing, err := vault.revision(ctx, tx, revision.ID)
	switch {
	case err == nil:
		same, err := vault.sameRevision(ctx, tx, existing, revision)
		if err != nil {
			return Revision{}, err
		}

		if !same {
			return Revision{}, ErrRevisionConflict
		}

		return existing, nil
	case !errors.Is(err, ErrNotFound):
		return Revision{}, err
	}

	// After the idempotency check, like the head comparison: a retry whose
	// first attempt was applied before a rotation gets that revision back.
	// Under the vault row lock, which every epoch change takes too, so no
	// revision is accepted under an epoch that a committed rotation, on any
	// replica, has replaced (SPEC.md §9.3). A pending rotation leaves the
	// current epoch in place, so commits under it go on until the next
	// epoch exists.
	// A plaintext commit to a converted vault: the vault was converted
	// after the device last read it (ConvertVault). A vault created
	// encrypted never had plaintext commits.
	if converted && revision.Epoch == 0 {
		return Revision{}, ErrVaultEncrypted
	}

	if revision.Epoch != currentEpoch || (encryption == EncryptionE2EE && currentEpoch == 0) {
		return Revision{}, ErrEpochNotCurrent
	}

	document, err := vault.document(ctx, tx, revision.DocumentID, "FOR NO KEY UPDATE")

	isNew := errors.Is(err, ErrNotFound)
	switch {
	case isNew && revision.BaseRevID.Valid:
		return Revision{}, ErrDocumentNotFound
	case isNew:
	case err != nil:
		return Revision{}, err
	case !revision.BaseRevID.Valid || revision.BaseRevID.UUID != document.HeadRevID:
		return Revision{}, &HeadMovedError{Document: document}
	case document.Kind != revision.Kind:
		return Revision{}, ErrKindMismatch
	}

	if revision.PathMustBeCurrent {
		if err := vault.checkPathCurrent(ctx, tx, isNew, document, revision); err != nil {
			return Revision{}, err
		}
	}

	if err := vault.checkContent(ctx, tx, revision); err != nil {
		return Revision{}, err
	}

	var seq int64

	err = tx.QueryRow(ctx, `UPDATE vaults SET head_seq = head_seq + 1 WHERE id = $1 RETURNING head_seq`, vault.vaultID).Scan(&seq)
	if err != nil {
		return Revision{}, fmt.Errorf("advance head_seq: %w", err)
	}

	storedPath, storedPathKey := storedText(revision.Epoch, revision.Path), storedText(revision.Epoch, revision.PathKey)

	// documents mirrors the head revision (head_rev_id, path_key, deleted)
	// and is written in the same transaction as the revision: the live
	// path_key index relies on deleted being accurate.
	if isNew {
		_, err = tx.Exec(ctx, `
			INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key, deleted)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			revision.DocumentID, vault.vaultID, revision.Kind, revision.ID, storedPathKey, revision.Deleted)
	} else {
		_, err = tx.Exec(ctx, `
			UPDATE documents SET head_rev_id = $3, path_key = $4, deleted = $5
			WHERE vault_id = $1 AND id = $2`,
			vault.vaultID, revision.DocumentID, revision.ID, storedPathKey, revision.Deleted)
	}

	if err != nil {
		return Revision{}, fmt.Errorf("write document: %w", err)
	}

	// File/folder collisions (SPEC.md §5). After the document write, so
	// the schema has already bounded the path key and refused an equal
	// live one, and the document's own row holds its new key: a document
	// may move into or out of the folder its old path named. Under the
	// vault row lock, so no concurrent commit to this vault, on any
	// replica, can add the other side of a collision until this one
	// commits. An E2EE path_key is an HMAC, not a path, so it has no
	// folders to compare. A revision that keeps its live path key is not
	// checked again, so this never refuses an edit or a delete.
	pathKeyChanged := isNew || document.Deleted || document.PathKey != storedPathKey
	if !revision.Deleted && pathKeyChanged && encryption == EncryptionNone {
		if err := vault.checkPathFolders(ctx, tx, revision); err != nil {
			return Revision{}, err
		}
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, deleted, device_id, epoch)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		revision.ID, revision.DocumentID, vault.vaultID, seq, revision.BaseRevID, revision.ContentRef,
		storedPath, revision.Deleted, revision.DeviceID, revision.Epoch)
	if err != nil {
		return Revision{}, fmt.Errorf("insert revision: %w", err)
	}

	// Delivered to every server replica's realtime hub exactly when this
	// transaction commits, and never if it rolls back (SPEC.md §6.4).
	if err := notifyVaultChanged(ctx, tx, VaultChange{VaultID: vault.vaultID, Seq: seq}); err != nil {
		return Revision{}, err
	}

	return vault.revision(ctx, tx, revision.ID)
}

// encryptedTextEncoding keeps the ciphertext paths and HMAC path keys of
// encrypted revisions in the text columns revisions.path and
// documents.path_key, which cannot hold NUL or invalid UTF-8 (SPEC.md §5).
// Its alphabet has no "/", so an encoded path key has no folders for the
// plaintext folder index (migration 0004) to find.
var encryptedTextEncoding = base64.RawURLEncoding

// storedText returns the column value of a revision's path or path key: the
// value itself at epoch 0 (plaintext), its encryptedTextEncoding at a later
// epoch.
func storedText(epoch int32, value string) string {
	if epoch == 0 {
		return value
	}

	return encryptedTextEncoding.EncodeToString([]byte(value))
}

// loadedText reverses storedText.
func loadedText(epoch int32, stored string) (string, error) {
	if epoch == 0 {
		return stored, nil
	}

	value, err := encryptedTextEncoding.DecodeString(stored)
	if err != nil {
		return "", fmt.Errorf("decode encrypted path: %w", err)
	}

	return string(value), nil
}

// checkPathCurrent returns ErrPathNotCurrent unless document exists, is
// live, and its head revision's path is exactly revision's. Under the
// document's row lock, so the head cannot move meanwhile.
func (vault *VaultStore) checkPathCurrent(ctx context.Context, tx pgx.Tx, isNew bool, document Document, revision NewRevision) error {
	if isNew || document.Deleted {
		return ErrPathNotCurrent
	}

	head, err := vault.revision(ctx, tx, document.HeadRevID)
	if err != nil {
		return fmt.Errorf("look up head revision: %w", err)
	}

	if head.Path != revision.Path {
		return ErrPathNotCurrent
	}

	return nil
}

// Folder collision probes for a path key ($2) in a vault ($1), each
// selecting the live documents it collides with (migration 0004). The
// indexes find candidates by digest; each probe then compares the
// candidates' real path keys, so a digest collision can never refuse a
// commit (#428). There are no more candidates than digest matches.
const (
	// folderIsLiveQuery: a live document other than a folder document has
	// a key that is a folder of the key. One probe of
	// documents_live_path_key_idx per folder of the key.
	folderIsLiveQuery = `
		SELECT 1 FROM documents
		WHERE vault_id = $1 AND NOT deleted AND kind <> 'folder'
			AND documents_path_key_digest(path_key) = ANY (ARRAY(
				SELECT documents_path_key_digest(folder) FROM unnest(documents_path_key_folders($2)) AS folder))
			AND path_key = ANY (documents_path_key_folders($2))`
	// isLiveFolderQuery: the key is a folder of a live document's key. One
	// probe of the GIN index documents_live_folder_idx, whose digests
	// already cover the vault id. The vault filter sits outside an
	// OFFSET 0 fence so the planner cannot answer the query by walking
	// every live document of the vault through the vault_id btree.
	isLiveFolderQuery = `
		SELECT 1 FROM (
			SELECT vault_id, path_key FROM documents
			WHERE NOT deleted AND documents_folder_digests(vault_id, path_key) @> ARRAY[documents_folder_digest($1, $2)]
			OFFSET 0
		) AS candidates
		WHERE vault_id = $1 AND starts_with(path_key, $2 || '/')`
)

// checkPathFolders returns ErrPathFolderTaken if a live document's path_key
// is a folder of revision's (a proper prefix ending before a "/"), or
// revision's is a folder of a live document's, unless the document that is
// the folder is a folder document: a folder document may hold other live
// documents. A key is never a folder of itself, so the document's own row
// cannot match. Both directions are index probes, bounded by the number of
// folders in one key.
func (vault *VaultStore) checkPathFolders(ctx context.Context, tx pgx.Tx, revision NewRevision) error {
	query := `SELECT EXISTS (` + folderIsLiveQuery + `)`
	if revision.Kind != KindFolder {
		query += ` OR EXISTS (` + isLiveFolderQuery + `)`
	}

	var taken bool

	err := tx.QueryRow(ctx, query, vault.vaultID, revision.PathKey).Scan(&taken)
	if err != nil {
		return fmt.Errorf("check path folders: %w", err)
	}

	if taken {
		return ErrPathFolderTaken
	}

	return nil
}

// sameRevision reports whether a retried commit matches the revision its
// first attempt committed.
//
// The parent is the one field that can change after a commit: when
// retention purges the parent, the revision is re-parented onto the nearest
// retained ancestor (PurgeRevisions). A retry still names the purged
// revision as its base, so a base that no longer exists anywhere matches
// whatever parent the revision has now. The first attempt was accepted, so
// its base existed then.
func (vault *VaultStore) sameRevision(ctx context.Context, tx pgx.Tx, existing Revision, revision NewRevision) (bool, error) {
	if !sameRevisionFields(existing, revision) {
		return false, nil
	}

	if existing.DeviceID != revision.DeviceID {
		same, err := removedDeviceOf(ctx, tx, existing.DeviceID, revision.UserID)
		if err != nil || !same {
			return false, err
		}
	}

	if existing.ParentRevID == revision.BaseRevID {
		return true, nil
	}

	if !revision.BaseRevID.Valid {
		return false, nil
	}

	// Not scoped to the vault: an id that exists in another vault was never
	// this vault's purged revision.
	var exists bool

	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM revisions WHERE id = $1)`, revision.BaseRevID.UUID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("look up base revision: %w", err)
	}

	return !exists, nil
}

// checkContent checks a revision's content: none for a folder (with a zero
// size); otherwise a complete blob in this vault of the claimed size.
func (vault *VaultStore) checkContent(ctx context.Context, tx pgx.Tx, revision NewRevision) error {
	if revision.Kind == KindFolder {
		if revision.ContentRef != nil || revision.ContentSize != 0 {
			return ErrContentKind
		}

		return nil
	}

	if revision.ContentRef == nil {
		return ErrContentKind
	}

	return checkCompleteBlob(ctx, tx, vault.vaultID, revision.ContentRef, revision.ContentSize)
}

// sameRevisionFields compares every field of a retried commit with the
// revision its first attempt committed, except the parent and the device.
func sameRevisionFields(existing Revision, revision NewRevision) bool {
	return existing.DocumentID == revision.DocumentID &&
		existing.Kind == revision.Kind &&
		bytes.Equal(existing.ContentRef, revision.ContentRef) &&
		existing.ContentSize == revision.ContentSize &&
		existing.Path == revision.Path &&
		existing.Deleted == revision.Deleted &&
		existing.Epoch == revision.Epoch
}

// removedDeviceOf reports whether deviceID, the device that committed a
// revision, is userID's and removed. A retry under another device of the
// same user after that device was removed is the same installation, which
// registered again while the response to its first attempt was lost
// (#590), so it gets the committed revision back. While the committing
// device is not removed, a retry under another device is a reused revision
// id. The retrying device was locked as userID's (lockDevice), so another
// user's device never matches.
func removedDeviceOf(ctx context.Context, tx pgx.Tx, deviceID, userID uuid.UUID) (bool, error) {
	var same bool

	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM devices WHERE id = $1 AND user_id = $2 AND removed_at IS NOT NULL)`, deviceID, userID).Scan(&same)
	if err != nil {
		return false, fmt.Errorf("look up committing device: %w", err)
	}

	return same, nil
}

// commitError maps constraint violations to CommitRevision errors.
func commitError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}

	switch {
	case pgErr.Code == uniqueViolation && pgErr.ConstraintName == livePathKeyIndex:
		return ErrPathKeyTaken
	case pgErr.Code == uniqueViolation && idConstraints[pgErr.ConstraintName]:
		// A client-generated id that exists in another vault: lookups
		// in this vault did not find it, but ids are globally unique.
		return ErrIDInUse
	case pgErr.Code == checkViolation && pathConstraints[pgErr.ConstraintName],
		// Path and path key are a commit's only free-form text, so
		// text PostgreSQL cannot store (NUL, invalid UTF-8) is one of
		// them.
		pgErr.Code == characterNotInRepertoire:
		return ErrInvalidPath
	default:
		return err
	}
}

// pathConstraints bound the size of paths and path keys.
var pathConstraints = map[string]bool{
	"documents_path_key_length": true,
	"revisions_path_length":     true,
}

// PostgreSQL SQLSTATEs.
const (
	uniqueViolation          = "23505"
	checkViolation           = "23514"
	characterNotInRepertoire = "22021"
)

// Changes is one page of a vault's change feed.
type Changes struct {
	// Revisions have seq > the requested cursor, in ascending seq order.
	Revisions []Revision
	// HasMore reports whether revisions after the last one returned exist.
	HasMore bool
	// HeadSeq is the vault's head_seq in the same snapshot.
	HeadSeq int64
	// Diverged reports that an anchor was given that the vault holds
	// neither as a revision nor as a purge marker at its seq. Revisions is
	// then empty and HasMore false.
	Diverged bool
}

// SeqAnchor names a revision a client applied or committed: its seq and its
// anchor (SPEC.md §6.1).
type SeqAnchor struct {
	Seq    int64
	Anchor uuid.UUID
}

// ListChanges returns up to limit revisions with seq > since in ascending
// seq order (SPEC.md §6.1), and the vault's head_seq, read from one
// snapshot.
//
// Each of anchors is a revision the client claims the vault holds: the one
// at its cursor (since), and the latest acknowledged commit of its own above
// the cursor. The vault holds it if a revision at that seq has that anchor,
// or retention purged it, leaving a purge marker with that seq and anchor
// (SPEC.md §11). Unless the vault holds every one, its history no longer
// contains them: a database restore lost them, and new commits may have
// reused their seqs. ListChanges then returns only Diverged and HeadSeq, so
// the client resyncs (SPEC.md §8). Anchors are random, so no other revision
// matches, and a purge never makes a false positive. A revision purged
// before purge markers existed (or by a server without them) has none, and
// still does.
func (vault *VaultStore) ListChanges(ctx context.Context, since int64, anchors []SeqAnchor, limit int) (Changes, error) {
	var changes Changes

	err := pgx.BeginTxFunc(ctx, vault.store.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT head_seq FROM vaults WHERE id = $1`, vault.vaultID).Scan(&changes.HeadSeq)
		if err != nil {
			return notFound(err, "look up head_seq")
		}

		for _, anchor := range anchors {
			var held bool

			err = tx.QueryRow(ctx, `
				SELECT EXISTS (SELECT 1 FROM revisions WHERE vault_id = $1 AND seq = $2 AND anchor = $3)
					OR EXISTS (SELECT 1 FROM purged_revisions WHERE vault_id = $1 AND seq = $2 AND anchor = $3)`,
				vault.vaultID, anchor.Seq, anchor.Anchor).Scan(&held)
			if err != nil {
				return fmt.Errorf("check anchor: %w", err)
			}

			if !held {
				changes.Diverged = true

				return nil
			}
		}

		// One extra row tells whether another page exists.
		revisions, err := vault.revisions(ctx, tx, `r.seq > $2 ORDER BY r.seq LIMIT $3`, since, limit+1)
		if err != nil {
			return err
		}

		changes.HasMore = len(revisions) > limit
		changes.Revisions = revisions[:min(len(revisions), limit)]

		return nil
	})
	if err != nil {
		return Changes{}, err
	}

	return changes, nil
}

// History is one page of a document's history.
type History struct {
	Document Document
	// Revisions are newest (highest seq) first.
	Revisions []Revision
	// HasMore reports whether older revisions exist.
	HasMore bool
	// DeviceNames maps the id of each device that committed one of
	// Revisions to its registered name.
	DeviceNames map[uuid.UUID]string
	// UserNames maps the id of each user that committed one of Revisions
	// to its display name.
	UserNames map[uuid.UUID]string
}

// DocumentHistory returns the document documentID and up to limit of its
// revisions with seq < before (all of them if before is zero), newest first,
// and the names of the devices and users that committed them, read from one snapshot. It returns ErrNotFound if the document does not
// exist in this vault.
func (vault *VaultStore) DocumentHistory(ctx context.Context, documentID uuid.UUID, before int64, limit int) (History, error) {
	var history History

	err := pgx.BeginTxFunc(ctx, vault.store.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var err error

		history.Document, err = vault.document(ctx, tx, documentID, "")
		if err != nil {
			return err
		}

		if before == 0 {
			before = math.MaxInt64
		}

		revisions, err := vault.revisions(ctx, tx, `r.document_id = $2 AND r.seq < $3 ORDER BY r.seq DESC LIMIT $4`,
			documentID, before, limit+1)
		if err != nil {
			return err
		}

		history.HasMore = len(revisions) > limit
		history.Revisions = revisions[:min(len(revisions), limit)]

		history.DeviceNames, err = deviceNames(ctx, tx, history.Revisions)
		if err != nil {
			return err
		}

		history.UserNames, err = userNames(ctx, tx, history.Revisions)

		return err
	})
	if err != nil {
		return History{}, err
	}

	return history, nil
}

// userNames returns the display names of the users that committed
// revisions. It reads only those users, so it names no user without a
// revision the caller may read.
func userNames(ctx context.Context, tx pgx.Tx, revisions []Revision) (map[uuid.UUID]string, error) {
	ids := make([]uuid.UUID, 0, len(revisions))
	for _, revision := range revisions {
		ids = append(ids, revision.UserID)
	}

	rows, err := tx.Query(ctx, `SELECT id, display_name FROM users WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("read user names: %w", err)
	}

	type userName struct {
		ID   uuid.UUID
		Name string
	}

	users, err := pgx.CollectRows(rows, pgx.RowToStructByPos[userName])
	if err != nil {
		return nil, fmt.Errorf("read user names: %w", err)
	}

	names := make(map[uuid.UUID]string, len(users))
	for _, user := range users {
		names[user.ID] = user.Name
	}

	return names, nil
}

// deviceNames returns the names of the devices that committed revisions.
// It reads only those devices, so it names no device without a revision the
// caller may read.
func deviceNames(ctx context.Context, tx pgx.Tx, revisions []Revision) (map[uuid.UUID]string, error) {
	ids := make([]uuid.UUID, 0, len(revisions))
	for _, revision := range revisions {
		ids = append(ids, revision.DeviceID)
	}

	rows, err := tx.Query(ctx, `SELECT id, name FROM devices WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("read device names: %w", err)
	}

	type deviceName struct {
		ID   uuid.UUID
		Name string
	}

	devices, err := pgx.CollectRows(rows, pgx.RowToStructByPos[deviceName])
	if err != nil {
		return nil, fmt.Errorf("read device names: %w", err)
	}

	names := make(map[uuid.UUID]string, len(devices))
	for _, device := range devices {
		names[device.ID] = device.Name
	}

	return names, nil
}
