//go:build sim

package sim_test

import (
	"context"
	"encoding/hex"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/solidDoWant/vault-sync/internal/pathkey"
)

// Invariant names, as reported to the harness and recorded in regression
// cases.
const (
	// invariantHistory: an acknowledged revision is missing from history,
	// or differs from what was acknowledged.
	invariantHistory = "history"
	// invariantSeq: the vault's seq values are not exactly 1..head_seq.
	invariantSeq = "seq"
	// invariantPathKey: two live documents share a path_key.
	invariantPathKey = "path-key"
	// invariantPathFolder: a live document's path_key is a folder (a
	// proper prefix ending before a "/") of another live document's.
	invariantPathFolder = "path-folder"
	// invariantStaleBase: a commit succeeded against a base other than the
	// document's head at that moment, so the document's history forks (or
	// has a second root).
	invariantStaleBase = "stale-base"
	// invariantDocumentHead: a document row does not mirror its head
	// revision (head_rev_id, deleted, path_key).
	invariantDocumentHead = "document-head"
)

// acknowledgement is a revision the server acknowledged to a simulated
// client (sim/client.ts Acknowledgement).
type acknowledgement struct {
	Client           int    `json:"client"`
	RevisionID       string `json:"revisionId"`
	DocumentID       string `json:"documentId"`
	Seq              string `json:"seq"`
	ParentRevisionID string `json:"parentRevisionId"`
	Path             string `json:"path"`
	Deleted          bool   `json:"deleted"`
	BlobID           string `json:"blobId"`
	Size             string `json:"size"`
}

// violation is a broken invariant (sim/client.ts Violation).
type violation struct {
	Invariant string `json:"invariant"`
	Detail    string `json:"detail"`
}

type storedRevision struct {
	id         uuid.UUID
	documentID uuid.UUID
	seq        int64
	parent     uuid.NullUUID
	blobID     []byte
	size       int64
	path       string
	deleted    bool
}

type storedDocument struct {
	id      uuid.UUID
	head    uuid.UUID
	pathKey string
	deleted bool
}

// checkInvariants reads the vault's state directly from PostgreSQL, in one
// snapshot, and returns every server-side invariant (SPEC.md §13, Phase 1)
// it violates. acknowledged lists every revision the server acknowledged to
// a client during the run.
func checkInvariants(ctx context.Context, db *pgxpool.Pool, vaultID uuid.UUID, acknowledged []acknowledgement) ([]violation, error) {
	var (
		headSeq   int64
		revisions []storedRevision
		documents []storedDocument
	)

	err := pgx.BeginTxFunc(ctx, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT head_seq FROM vaults WHERE id = $1`, vaultID).Scan(&headSeq)
		if err != nil {
			return fmt.Errorf("read head_seq: %w", err)
		}

		rows, err := tx.Query(ctx, `
			SELECT r.id, r.document_id, r.seq, r.parent_rev_id, r.content_ref, COALESCE(b.size, -1), r.path, r.deleted
			FROM revisions r LEFT JOIN blobs b ON b.vault_id = r.vault_id AND b.blob_id = r.content_ref
			WHERE r.vault_id = $1 ORDER BY r.seq`, vaultID)
		if err != nil {
			return fmt.Errorf("read revisions: %w", err)
		}

		revisions, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (storedRevision, error) {
			var revision storedRevision

			err := row.Scan(&revision.id, &revision.documentID, &revision.seq, &revision.parent, &revision.blobID, &revision.size, &revision.path, &revision.deleted)

			return revision, err
		})
		if err != nil {
			return fmt.Errorf("read revisions: %w", err)
		}

		rows, err = tx.Query(ctx, `SELECT id, head_rev_id, path_key, deleted FROM documents WHERE vault_id = $1 ORDER BY id`, vaultID)
		if err != nil {
			return fmt.Errorf("read documents: %w", err)
		}

		documents, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (storedDocument, error) {
			var document storedDocument

			err := row.Scan(&document.id, &document.head, &document.pathKey, &document.deleted)

			return document, err
		})
		if err != nil {
			return fmt.Errorf("read documents: %w", err)
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	var violations []violation

	report := func(invariant, format string, arguments ...any) {
		violations = append(violations, violation{Invariant: invariant, Detail: fmt.Sprintf(format, arguments...)})
	}

	checkHistory(revisions, acknowledged, report)
	checkSeq(headSeq, revisions, report)
	checkChains(revisions, report)
	checkDocuments(documents, revisions, report)

	return violations, nil
}

type reporter func(invariant, format string, arguments ...any)

// checkHistory: no acknowledged revision is missing from history (SPEC.md §2
// principle 1), and each is stored exactly as it was acknowledged.
func checkHistory(revisions []storedRevision, acknowledged []acknowledgement, report reporter) {
	byID := make(map[string]storedRevision, len(revisions))
	for _, revision := range revisions {
		byID[revision.id.String()] = revision
	}

	for _, ack := range acknowledged {
		stored, ok := byID[ack.RevisionID]
		if !ok {
			report(invariantHistory, "revision %s acknowledged to c%d (seq %s) is missing from history", ack.RevisionID, ack.Client, ack.Seq)

			continue
		}

		parent := ""
		if stored.parent.Valid {
			parent = stored.parent.UUID.String()
		}

		storedFields := fmt.Sprintf("document=%s seq=%d parent=%s path=%q deleted=%t blob=%s size=%d",
			stored.documentID, stored.seq, parent, stored.path, stored.deleted, hex.EncodeToString(stored.blobID), stored.size)
		ackedFields := fmt.Sprintf("document=%s seq=%s parent=%s path=%q deleted=%t blob=%s size=%s",
			ack.DocumentID, ack.Seq, ack.ParentRevisionID, ack.Path, ack.Deleted, ack.BlobID, ack.Size)

		if storedFields != ackedFields {
			report(invariantHistory, "revision %s was acknowledged as {%s} but is stored as {%s}", ack.RevisionID, ackedFields, storedFields)
		}
	}
}

// checkSeq: seq values are exactly 1..head_seq (gapless, unique, and
// monotonic in commit order; nothing is purged during a run).
func checkSeq(headSeq int64, revisions []storedRevision, report reporter) {
	for index, revision := range revisions {
		if expected := int64(index) + 1; revision.seq != expected {
			report(invariantSeq, "revision %s has seq %d where seq %d was expected (seq must be gapless)", revision.id, revision.seq, expected)

			return
		}
	}

	if int64(len(revisions)) != headSeq {
		report(invariantSeq, "head_seq is %d but the vault has %d revisions", headSeq, len(revisions))
	}
}

// checkChains: in seq order, each document's revisions form one chain, each
// based on the one before. A commit accepted against a stale base would give
// a revision whose parent is not the previous head.
func checkChains(revisions []storedRevision, report reporter) {
	heads := map[uuid.UUID]uuid.UUID{}

	for _, revision := range revisions {
		head, exists := heads[revision.documentID]

		switch {
		case !exists && revision.parent.Valid:
			report(invariantStaleBase, "revision %s (seq %d) is the first of document %s but has base %s",
				revision.id, revision.seq, revision.documentID, revision.parent.UUID)
		case exists && !revision.parent.Valid:
			report(invariantStaleBase, "revision %s (seq %d) of document %s has no base although the head was %s",
				revision.id, revision.seq, revision.documentID, head)
		case exists && revision.parent.UUID != head:
			report(invariantStaleBase, "revision %s (seq %d) of document %s was accepted against stale base %s; the head was %s",
				revision.id, revision.seq, revision.documentID, revision.parent.UUID, head)
		}

		heads[revision.documentID] = revision.id
	}
}

// checkDocuments: each document mirrors its head revision, no two live
// documents share a path_key, and no live document's path_key is a folder of
// another's.
func checkDocuments(documents []storedDocument, revisions []storedRevision, report reporter) {
	latest := map[uuid.UUID]storedRevision{}
	for _, revision := range revisions {
		latest[revision.documentID] = revision
	}

	live := map[string]uuid.UUID{}

	for _, document := range documents {
		head, ok := latest[document.id]

		switch {
		case !ok:
			report(invariantDocumentHead, "document %s has no revisions", document.id)
		case document.head != head.id:
			report(invariantDocumentHead, "document %s has head %s but its latest revision is %s", document.id, document.head, head.id)
		case document.deleted != head.deleted:
			report(invariantDocumentHead, "document %s has deleted=%t but its head revision has deleted=%t", document.id, document.deleted, head.deleted)
		case document.pathKey != pathkey.Key(head.path):
			report(invariantDocumentHead, "document %s has path_key %q but its head path %q normalizes to %q",
				document.id, document.pathKey, head.path, pathkey.Key(head.path))
		}

		if document.deleted {
			continue
		}

		if other, taken := live[document.pathKey]; taken {
			report(invariantPathKey, "live documents %s and %s share path_key %q", other, document.id, document.pathKey)

			continue
		}

		live[document.pathKey] = document.id
	}

	for key, document := range live {
		for end := range len(key) {
			if key[end] != '/' {
				continue
			}

			if folder, taken := live[key[:end]]; taken {
				report(invariantPathFolder, "live document %s has path_key %q, a folder of live document %s's %q", folder, key[:end], document, key)
			}
		}
	}
}
