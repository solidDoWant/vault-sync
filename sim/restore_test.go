//go:build sim

package sim_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// vaultSnapshot is a vault's change history as a database backup holds it:
// its documents and revisions rows, and its head_seq.
type vaultSnapshot struct {
	documents []byte
	revisions []byte
	headSeq   int64
}

// takeSnapshot copies vaultID's documents and revisions rows, whole, as JSON,
// in one snapshot.
func takeSnapshot(ctx context.Context, db *pgxpool.Pool, vaultID uuid.UUID) (vaultSnapshot, error) {
	var snapshot vaultSnapshot

	err := pgx.BeginTxFunc(ctx, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT
				(SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]') FROM documents d WHERE d.vault_id = $1),
				(SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]') FROM revisions r WHERE r.vault_id = $1),
				(SELECT head_seq FROM vaults WHERE id = $1)`, vaultID).
			Scan(&snapshot.documents, &snapshot.revisions, &snapshot.headSeq)
	})
	if err != nil {
		return vaultSnapshot{}, fmt.Errorf("snapshot vault: %w", err)
	}

	return snapshot, nil
}

// restoreSnapshot puts vaultID's change history back to snapshot, as a
// restore of a PostgreSQL backup taken then would (SPEC.md §8, issue #155):
// every document and revision committed since is gone, the rows that
// existed are back exactly (revision anchors included), and head_seq is
// back where it was, so the next commit reuses seqs clients have applied.
// Blobs stay: a restored database may reference blobs whose objects are
// still in S3, and extra blob rows reference nothing.
func restoreSnapshot(ctx context.Context, db *pgxpool.Pool, vaultID uuid.UUID, snapshot vaultSnapshot) error {
	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		// documents.head_rev_id is checked at commit.
		statements := []struct {
			sql       string
			arguments []any
		}{
			{`DELETE FROM revisions WHERE vault_id = $1`, []any{vaultID}},
			{`DELETE FROM documents WHERE vault_id = $1`, []any{vaultID}},
			{`INSERT INTO documents SELECT * FROM jsonb_populate_recordset(NULL::documents, $1)`, []any{snapshot.documents}},
			{`INSERT INTO revisions SELECT * FROM jsonb_populate_recordset(NULL::revisions, $1)`, []any{snapshot.revisions}},
			{`UPDATE vaults SET head_seq = $2 WHERE id = $1`, []any{vaultID, snapshot.headSeq}},
		}

		for _, statement := range statements {
			if _, err := tx.Exec(ctx, statement.sql, statement.arguments...); err != nil {
				return fmt.Errorf("%s: %w", statement.sql, err)
			}
		}

		return nil
	})
	if err != nil {
		return fmt.Errorf("restore vault: %w", err)
	}

	return nil
}

// vaultIDFromBody decodes a {"vaultId": ...} request body.
func vaultIDFromBody(request *http.Request) (uuid.UUID, error) {
	var body struct {
		VaultID string `json:"vaultId"`
	}

	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		return uuid.UUID{}, err
	}

	return uuid.Parse(body.VaultID)
}

// snapshot backs up a vault's change history (takeSnapshot) for a later
// restore; a later snapshot of the same vault replaces it.
func (control *control) snapshot(writer http.ResponseWriter, request *http.Request) {
	vaultID, err := vaultIDFromBody(request)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)

		return
	}

	snapshot, err := takeSnapshot(request.Context(), control.db, vaultID)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	control.mu.Lock()
	if control.snapshots == nil {
		control.snapshots = map[uuid.UUID]vaultSnapshot{}
	}

	control.snapshots[vaultID] = snapshot
	control.mu.Unlock()

	respond(writer, map[string]int64{"headSeq": snapshot.headSeq})
}

// restore restores a vault's last snapshot (restoreSnapshot).
func (control *control) restore(writer http.ResponseWriter, request *http.Request) {
	vaultID, err := vaultIDFromBody(request)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)

		return
	}

	control.mu.Lock()
	snapshot, ok := control.snapshots[vaultID]
	control.mu.Unlock()

	if !ok {
		http.Error(writer, errors.New("no snapshot of this vault").Error(), http.StatusBadRequest)

		return
	}

	if err := restoreSnapshot(request.Context(), control.db, vaultID, snapshot); err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	respond(writer, map[string]int64{"headSeq": snapshot.headSeq})
}
