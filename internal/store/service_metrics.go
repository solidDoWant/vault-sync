package store

import (
	"context"
	"fmt"
	"time"
)

// The queries in this file feed the service-wide metrics (docs/configuration.md,
// Service-wide metrics). Each returns counts over the whole deployment and
// nothing that identifies a user, vault or device. Each must stay cheap at
// 100k vaults and 10M revisions: the small tables (devices, vaults,
// vault_members, vault_invitations, key_slots) are scanned whole; the large
// ones (documents, revisions, blobs) are only estimated from the planner
// statistics or a page sample, or read through an index that holds just
// the rows counted. Each query's comment gives its cost.

// DeviceCounts counts the devices that have not been removed.
type DeviceCounts struct {
	// Devices is the number of devices not removed.
	Devices int64
	// Users is the number of users with at least one device not removed.
	Users int64
	// ActiveDay and ActiveMonth are the devices not removed that committed
	// within the last 24 hours and 30 days. A device's last activity is
	// recorded at most once per deviceLastSeenGranularity.
	ActiveDay   int64
	ActiveMonth int64
}

// CountDevices returns the device counts in one scan of devices.
func (store *Store) CountDevices(ctx context.Context) (DeviceCounts, error) {
	var counts DeviceCounts

	err := store.pool.QueryRow(ctx, `
		SELECT count(*),
			count(DISTINCT user_id),
			count(*) FILTER (WHERE last_seen > now() - interval '24 hours'),
			count(*) FILTER (WHERE last_seen > now() - interval '30 days')
		FROM devices
		WHERE removed_at IS NULL`).Scan(&counts.Devices, &counts.Users, &counts.ActiveDay, &counts.ActiveMonth)
	if err != nil {
		return DeviceCounts{}, fmt.Errorf("count devices: %w", err)
	}

	return counts, nil
}

// VaultCount is the number of vaults with one encryption mode and sharing
// state.
type VaultCount struct {
	// Encryption is the vault's encryption mode ("none" or "e2ee").
	Encryption string
	// Shared reports whether the vault has more than one member.
	Shared bool
	Count  int64
}

// CountVaults counts the vaults not deleted by encryption mode and by
// whether they have more than one member. Combinations without vaults are
// omitted.
func (store *Store) CountVaults(ctx context.Context) ([]VaultCount, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT v.encryption, coalesce(m.members, 0) > 1 AS shared, count(*)
		FROM vaults v
		LEFT JOIN (SELECT vault_id, count(*) AS members FROM vault_members GROUP BY vault_id) m ON m.vault_id = v.id
		WHERE v.deleted_at IS NULL
		GROUP BY 1, 2`)
	if err != nil {
		return nil, fmt.Errorf("count vaults: %w", err)
	}
	defer rows.Close()

	var counts []VaultCount

	for rows.Next() {
		var count VaultCount
		if err := rows.Scan(&count.Encryption, &count.Shared, &count.Count); err != nil {
			return nil, fmt.Errorf("count vaults: %w", err)
		}

		counts = append(counts, count)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("count vaults: %w", err)
	}

	return counts, nil
}

// CountMemberships returns the number of memberships of vaults not deleted.
func (store *Store) CountMemberships(ctx context.Context) (int64, error) {
	var count int64

	err := store.pool.QueryRow(ctx, `
		SELECT count(*) FROM vault_members m JOIN vaults v ON v.id = m.vault_id
		WHERE v.deleted_at IS NULL`).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count memberships: %w", err)
	}

	return count, nil
}

// CountPendingInvitations returns the number of unexpired invitations to
// vaults not deleted.
func (store *Store) CountPendingInvitations(ctx context.Context) (int64, error) {
	var count int64

	err := store.pool.QueryRow(ctx, `
		SELECT count(*) FROM vault_invitations i JOIN vaults v ON v.id = i.vault_id
		WHERE i.expires_at > now() AND v.deleted_at IS NULL`).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count pending invitations: %w", err)
	}

	return count, nil
}

// RowEstimates are approximate row counts from the planner statistics
// (pg_class.reltuples), which VACUUM, ANALYZE and autovacuum update. They
// are 0 for a relation never analyzed.
type RowEstimates struct {
	// LiveDocuments estimates the documents not deleted, from the partial
	// index that holds exactly those.
	LiveDocuments int64
	// Revisions estimates the revisions.
	Revisions int64
}

// EstimateRows returns the row estimates without scanning either table.
func (store *Store) EstimateRows(ctx context.Context) (RowEstimates, error) {
	var estimates RowEstimates

	// reltuples is -1 for a relation never analyzed (PostgreSQL 14+).
	err := store.pool.QueryRow(ctx, `
		SELECT
			(SELECT greatest(reltuples, 0)::bigint FROM pg_class WHERE oid = 'documents_live_path_key_idx'::regclass),
			(SELECT greatest(reltuples, 0)::bigint FROM pg_class WHERE oid = 'revisions'::regclass)`,
	).Scan(&estimates.LiveDocuments, &estimates.Revisions)
	if err != nil {
		return RowEstimates{}, fmt.Errorf("estimate rows: %w", err)
	}

	return estimates, nil
}

// SchemaVersion returns the highest applied migration version.
func (store *Store) SchemaVersion(ctx context.Context) (int64, error) {
	var version int64

	err := store.pool.QueryRow(ctx, `SELECT coalesce(max(version), 0) FROM schema_migrations`).Scan(&version)
	if err != nil {
		return 0, fmt.Errorf("read schema version: %w", err)
	}

	return version, nil
}

// BlobEstimate estimates the stored blobs and their recorded sizes.
type BlobEstimate struct {
	// Blobs is the number of blob rows.
	Blobs int64
	// Bytes is the sum of their recorded sizes.
	Bytes int64
}

// BlobSampling bounds EstimateBlobs.
type BlobSampling struct {
	// ExactBelow is the planner's row estimate below which the blobs are
	// counted and summed exactly.
	ExactBelow int64
	// SamplePercent is the share of the table's pages read at or above
	// ExactBelow (TABLESAMPLE SYSTEM), 0 to 100.
	SamplePercent float64
}

// DefaultBlobSampling counts up to 100,000 blobs exactly and samples 1% of
// the table's pages beyond that.
var DefaultBlobSampling = BlobSampling{ExactBelow: 100_000, SamplePercent: 1}

// EstimateBlobs returns the blob count and bytes. Every revision with
// content references a blob, so blobs grows like revisions and a scan of
// it is not cheap at scale: below sampling.ExactBelow rows (planner
// estimate) it is scanned exactly, and at or above it the count is the
// planner estimate (pg_class.reltuples) and the bytes are that count times
// the mean size of a TABLESAMPLE SYSTEM sample, which reads only
// sampling.SamplePercent of the table's pages.
func (store *Store) EstimateBlobs(ctx context.Context, sampling BlobSampling) (BlobEstimate, error) {
	var rows int64

	err := store.pool.QueryRow(ctx, `
		SELECT greatest(reltuples, 0)::bigint FROM pg_class WHERE oid = 'blobs'::regclass`).Scan(&rows)
	if err != nil {
		return BlobEstimate{}, fmt.Errorf("estimate blobs: %w", err)
	}

	var estimate BlobEstimate

	if rows < sampling.ExactBelow {
		err := store.pool.QueryRow(ctx, `SELECT count(*), coalesce(sum(size), 0)::bigint FROM blobs`).
			Scan(&estimate.Blobs, &estimate.Bytes)
		if err != nil {
			return BlobEstimate{}, fmt.Errorf("count blobs: %w", err)
		}

		return estimate, nil
	}

	var meanSize float64

	err = store.pool.QueryRow(ctx, `
		SELECT coalesce(avg(size), 0)::float8 FROM blobs TABLESAMPLE SYSTEM ($1)`, sampling.SamplePercent).Scan(&meanSize)
	if err != nil {
		return BlobEstimate{}, fmt.Errorf("sample blobs: %w", err)
	}

	return BlobEstimate{Blobs: rows, Bytes: int64(meanSize * float64(rows))}, nil
}

// UploadSessions summarizes the open (uploading) blob upload sessions.
type UploadSessions struct {
	// Open is the number of open sessions.
	Open int64
	// ReservedBytes is the sum of their declared sizes.
	ReservedBytes int64
	// OldestCreatedAt is the creation time of the oldest open session; zero
	// without one.
	OldestCreatedAt time.Time
}

// CountUploadSessions summarizes the open upload sessions. It reads them
// through blob_uploads_active_blob_idx, which holds exactly the open
// sessions; idle ones are reaped after the upload TTL, so they stay few.
func (store *Store) CountUploadSessions(ctx context.Context) (UploadSessions, error) {
	var (
		sessions UploadSessions
		oldest   *time.Time
	)

	err := store.pool.QueryRow(ctx, `
		SELECT count(*), coalesce(sum(size), 0)::bigint, min(created_at)
		FROM blob_uploads WHERE state = 'uploading'`).Scan(&sessions.Open, &sessions.ReservedBytes, &oldest)
	if err != nil {
		return UploadSessions{}, fmt.Errorf("count upload sessions: %w", err)
	}

	if oldest != nil {
		sessions.OldestCreatedAt = *oldest
	}

	return sessions, nil
}

// ReleasedBlobCounts counts the blobs awaiting garbage collection.
type ReleasedBlobCounts struct {
	Blobs int64
	Bytes int64
}

// CountReleasedBlobs counts the blobs a purge released and the collector
// has not deleted (or found referenced again) yet, and their recorded
// sizes, through blobs_released_at_idx, which holds exactly those.
func (store *Store) CountReleasedBlobs(ctx context.Context) (ReleasedBlobCounts, error) {
	var counts ReleasedBlobCounts

	err := store.pool.QueryRow(ctx, `
		SELECT count(*), coalesce(sum(size), 0)::bigint FROM blobs WHERE released_at IS NOT NULL`).
		Scan(&counts.Blobs, &counts.Bytes)
	if err != nil {
		return ReleasedBlobCounts{}, fmt.Errorf("count released blobs: %w", err)
	}

	return counts, nil
}

// CountDeletedVaults returns the number of deleted vaults the purge has
// not removed yet, in one scan of vaults.
func (store *Store) CountDeletedVaults(ctx context.Context) (int64, error) {
	var count int64

	err := store.pool.QueryRow(ctx, `SELECT count(*) FROM vaults WHERE deleted_at IS NOT NULL`).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count deleted vaults: %w", err)
	}

	return count, nil
}

// StaleEpochCounts is the re-encryption backlog of encrypted vaults.
type StaleEpochCounts struct {
	// Vaults is the number of encrypted vaults not deleted with at least one
	// revision not on the vault's current epoch: a re-key in progress.
	Vaults int64
	// Revisions is the number of such revisions (the ListStaleRevisions
	// backlog, summed over every vault).
	Revisions int64
}

// CountStaleEpochRevisions returns the re-encryption backlog. It scans
// vaults and, for each encrypted vault, counts its revisions below and
// above the current epoch in revisions_vault_id_epoch_idx: two index
// probes per vault, plus one index entry per stale revision, so it costs
// the backlog itself, not the vault's history.
func (store *Store) CountStaleEpochRevisions(ctx context.Context) (StaleEpochCounts, error) {
	var counts StaleEpochCounts

	err := store.pool.QueryRow(ctx, `
		WITH stale AS MATERIALIZED (
			SELECT (SELECT count(*) FROM revisions r WHERE r.vault_id = v.id AND r.epoch < v.current_epoch)
				+ (SELECT count(*) FROM revisions r WHERE r.vault_id = v.id AND r.epoch > v.current_epoch) AS revisions
			FROM vaults v
			WHERE v.encryption = 'e2ee' AND v.deleted_at IS NULL
		)
		SELECT count(*) FILTER (WHERE revisions > 0), coalesce(sum(revisions), 0)::bigint FROM stale`).Scan(&counts.Vaults, &counts.Revisions)
	if err != nil {
		return StaleEpochCounts{}, fmt.Errorf("count stale epoch revisions: %w", err)
	}

	return counts, nil
}

// EscrowCounts is the number of encrypted vaults not deleted with escrow
// on and off.
type EscrowCounts struct {
	On  int64
	Off int64
}

// CountEscrowVaults counts the encrypted vaults not deleted by escrow, in
// one scan of vaults.
func (store *Store) CountEscrowVaults(ctx context.Context) (EscrowCounts, error) {
	var counts EscrowCounts

	err := store.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE escrow), count(*) FILTER (WHERE NOT escrow)
		FROM vaults WHERE encryption = 'e2ee' AND deleted_at IS NULL`).Scan(&counts.On, &counts.Off)
	if err != nil {
		return EscrowCounts{}, fmt.Errorf("count escrow vaults: %w", err)
	}

	return counts, nil
}

// CountEscrowSlotsNamingKeys returns the number of escrow key slots of
// vaults not deleted that name one of keyIDs: the re-wrap backlog of an
// escrow key rotation. It scans key_slots, which holds a row per epoch
// and recipient of each encrypted vault (a retired epoch's slots are
// deleted), so it grows like vault_members, not like revisions. Without
// keyIDs it is 0 and runs no query.
func (store *Store) CountEscrowSlotsNamingKeys(ctx context.Context, keyIDs []string) (int64, error) {
	if len(keyIDs) == 0 {
		return 0, nil
	}

	var count int64

	err := store.pool.QueryRow(ctx, `
		SELECT count(*) FROM key_slots k JOIN vaults v ON v.id = k.vault_id
		WHERE k.recipient_kind = 'escrow' AND k.recipient_id = ANY($1) AND v.deleted_at IS NULL`, keyIDs).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count escrow slots: %w", err)
	}

	return count, nil
}
