package store

import (
	"context"
	"fmt"
)

// The queries in this file feed the service-wide metrics (docs/configuration.md,
// Service-wide metrics). Each returns counts over the whole deployment and
// nothing that identifies a user, vault or device. Each must stay cheap at
// 100k vaults and 10M revisions: the small tables (devices, vaults,
// vault_members, vault_invitations) are scanned whole; the large ones
// (documents, revisions) are only estimated from the planner statistics.

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
