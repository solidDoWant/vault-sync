//go:build sim

package sim_test

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/solidDoWant/vault-sync/internal/config"
)

// agedUploadIdle is how long ageUploads makes upload sessions look idle:
// past the limited replica's reclaim idle (the default), so a BeginBlob in
// a vault at its session limit reclaims them, but well short of the upload
// TTL, so the cleanup routine does not remove them first.
const agedUploadIdle = config.DefaultBlobUploadReclaimIdle + time.Minute

// ageUploads makes every upload session of a vault that is still in
// progress look idle for agedUploadIdle, as if its uploader had gone
// silent that long (SPEC.md §6.2, #490). Only vaultID's sessions are aged,
// so concurrent runs keep theirs. It returns how many it aged.
func (control *control) ageUploads(writer http.ResponseWriter, request *http.Request) {
	vaultID, err := vaultIDFromBody(request)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)

		return
	}

	aged, err := ageUploadSessions(request.Context(), control.db, vaultID)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	respond(writer, map[string]int64{"aged": aged})
}

// ageUploadSessions backdates the activity of vaultID's sessions in
// progress by agedUploadIdle and returns how many it aged.
func ageUploadSessions(ctx context.Context, db *pgxpool.Pool, vaultID uuid.UUID) (int64, error) {
	tag, err := db.Exec(ctx, `
		UPDATE blob_uploads SET updated_at = now() - $2 * interval '1 microsecond'
		WHERE vault_id = $1 AND state = 'uploading'`, vaultID, agedUploadIdle.Microseconds())
	if err != nil {
		return 0, err
	}

	return tag.RowsAffected(), nil
}
