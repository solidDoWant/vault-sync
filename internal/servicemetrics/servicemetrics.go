// Package servicemetrics serves the service-wide metrics: values that
// describe the whole deployment rather than one replica, read from
// PostgreSQL (docs/configuration.md, Service-wide metrics).
//
// A scrape never queries the database. Refresher reads every value in the
// background on an interval, each query under its own timeout, and the
// scrape serves the last values read. A query that fails keeps its
// metrics' previous values. No metric carries a per-user, per-vault or
// per-device label.
package servicemetrics

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// DefaultQueryTimeout bounds each refresh query.
const DefaultQueryTimeout = 10 * time.Second

// Store runs the refresh queries; *store.Store implements it.
type Store interface {
	CountDevices(ctx context.Context) (store.DeviceCounts, error)
	CountVaults(ctx context.Context) ([]store.VaultCount, error)
	CountMemberships(ctx context.Context) (int64, error)
	CountPendingInvitations(ctx context.Context) (int64, error)
	EstimateRows(ctx context.Context) (store.RowEstimates, error)
	SchemaVersion(ctx context.Context) (int64, error)
	EstimateBlobs(ctx context.Context, sampling store.BlobSampling) (store.BlobEstimate, error)
	CountUploadSessions(ctx context.Context) (store.UploadSessions, error)
	CountReleasedBlobs(ctx context.Context) (store.ReleasedBlobCounts, error)
	CountDeletedVaults(ctx context.Context) (int64, error)
	CountStaleEpochRevisions(ctx context.Context) (store.StaleEpochCounts, error)
	CountEscrowVaults(ctx context.Context) (store.EscrowCounts, error)
	CountEscrowSlotsNamingKeys(ctx context.Context, keyIDs []string) (int64, error)
	LastRuns(ctx context.Context) (store.LastRuns, error)
}

// encryptions and sharing are the only label values of
// vault_sync_service_vaults; every combination is always exported.
var (
	encryptions = []string{"none", "e2ee"}
	sharing     = []bool{false, true}
)

// Metrics holds the service-wide gauges.
type Metrics struct {
	devices            prometheus.Gauge
	usersWithDevices   prometheus.Gauge
	activeDevicesDay   prometheus.Gauge
	activeDevicesMonth prometheus.Gauge
	vaults             *prometheus.GaugeVec
	memberships        prometheus.Gauge
	pendingInvitations prometheus.Gauge
	documents          prometheus.Gauge
	revisions          prometheus.Gauge
	schemaVersion      prometheus.Gauge
	blobs              prometheus.Gauge
	blobBytes          prometheus.Gauge
	uploadSessions     prometheus.Gauge
	uploadReserved     prometheus.Gauge
	uploadOldestAge    prometheus.Gauge
	gcPendingBlobs     prometheus.Gauge
	gcPendingBytes     prometheus.Gauge
	deletedVaults      prometheus.Gauge
	rekeyVaults        prometheus.Gauge
	staleRevisions     prometheus.Gauge
	escrowVaults       *prometheus.GaugeVec
	escrowRewrapSlots  prometheus.Gauge
	lastRetention      prometheus.Gauge
	lastExport         prometheus.Gauge
	lastSuccess        prometheus.Gauge
}

// NewMetrics returns the gauges, all zero.
func NewMetrics() *Metrics {
	gauge := func(name, help string) prometheus.Gauge {
		return prometheus.NewGauge(prometheus.GaugeOpts{Name: name, Help: help})
	}

	metrics := &Metrics{
		devices:            gauge("vault_sync_service_devices", "Devices registered and not removed."),
		usersWithDevices:   gauge("vault_sync_service_users_with_devices", "Users with at least one device not removed."),
		activeDevicesDay:   gauge("vault_sync_service_active_devices_24h", "Devices not removed that committed within the last 24 hours."),
		activeDevicesMonth: gauge("vault_sync_service_active_devices_30d", "Devices not removed that committed within the last 30 days."),
		vaults: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vault_sync_service_vaults",
			Help: "Vaults not deleted, by encryption (none, e2ee) and shared (true when the vault has more than one member).",
		}, []string{"encryption", "shared"}),
		memberships:        gauge("vault_sync_service_vault_memberships", "Memberships of vaults not deleted."),
		pendingInvitations: gauge("vault_sync_service_pending_invitations", "Unexpired invitations to vaults not deleted."),
		documents: gauge("vault_sync_service_live_documents_approximate",
			"Approximate documents not deleted, from PostgreSQL planner statistics (pg_class.reltuples), which autovacuum and ANALYZE update; 0 until the table is first analyzed."),
		revisions: gauge("vault_sync_service_revisions_approximate",
			"Approximate stored revisions, from PostgreSQL planner statistics (pg_class.reltuples), which autovacuum and ANALYZE update; 0 until the table is first analyzed."),
		schemaVersion: gauge("vault_sync_service_schema_version", "Highest database migration version applied."),
		blobs: gauge("vault_sync_service_blobs",
			"Stored blobs. Exact below 100,000; beyond that approximate, from PostgreSQL planner statistics (pg_class.reltuples), which autovacuum and ANALYZE update."),
		blobBytes: gauge("vault_sync_service_blob_bytes",
			"Recorded size in bytes of the stored blobs. Exact below 100,000 blobs; beyond that approximate: the approximate blob count times the mean size in a 1% page sample (TABLESAMPLE SYSTEM)."),
		uploadSessions: gauge("vault_sync_service_upload_sessions", "Open blob upload sessions."),
		uploadReserved: gauge("vault_sync_service_upload_session_reserved_bytes", "Declared size in bytes of the open blob upload sessions."),
		uploadOldestAge: gauge("vault_sync_service_upload_session_oldest_age_seconds",
			"Age in seconds of the oldest open blob upload session at the last refresh; 0 without one."),
		gcPendingBlobs: gauge("vault_sync_service_gc_pending_blobs",
			"Blobs released by a retention purge that the garbage collector has not deleted yet (still inside the grace period, or not yet collected)."),
		gcPendingBytes: gauge("vault_sync_service_gc_pending_blob_bytes", "Recorded size in bytes of the blobs awaiting garbage collection."),
		deletedVaults:  gauge("vault_sync_service_deleted_vaults", "Deleted vaults the vault purge has not removed yet."),
		rekeyVaults: gauge("vault_sync_service_rekey_vaults",
			"Encrypted vaults not deleted with a revision not on the vault's current epoch: a re-key in progress."),
		staleRevisions: gauge("vault_sync_service_stale_epoch_revisions",
			"Revisions of encrypted vaults not deleted that are not on their vault's current epoch: the re-encryption backlog."),
		escrowVaults: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "vault_sync_service_encrypted_vaults_by_escrow",
			Help: "Encrypted vaults not deleted, by escrow (true when escrow is on).",
		}, []string{"escrow"}),
		escrowRewrapSlots: gauge("vault_sync_service_escrow_rewrap_slots",
			"Escrow key slots of vaults not deleted that still name a retiring escrow key id (VAULT_SYNC_ESCROW_RETIRING_KEY_IDS); 0 without one."),
		lastRetention: gauge("vault_sync_service_retention_last_success_timestamp_seconds",
			"Unix time at which a retention run last finished without errors, on any replica; 0 before the first."),
		lastExport: gauge("vault_sync_service_export_last_success_timestamp_seconds",
			"Unix time at which an export last finished with status ok; 0 before the first."),
		lastSuccess: gauge("vault_sync_service_metrics_last_refresh_success_timestamp_seconds",
			"Unix time of the last refresh in which every service-wide query succeeded; 0 before the first. A failed query keeps its metrics' previous values."),
	}

	for _, encryption := range encryptions {
		for _, shared := range sharing {
			metrics.vaults.WithLabelValues(encryption, strconv.FormatBool(shared))
		}
	}

	for _, escrow := range sharing {
		metrics.escrowVaults.WithLabelValues(strconv.FormatBool(escrow))
	}

	return metrics
}

// Collectors returns every vault_sync_service_* collector. Every such
// metric must be registered through this function: the Service-wide
// metrics table in docs/configuration.md is checked against it.
func (metrics *Metrics) Collectors() []prometheus.Collector {
	return []prometheus.Collector{
		metrics.devices, metrics.usersWithDevices, metrics.activeDevicesDay, metrics.activeDevicesMonth,
		metrics.vaults, metrics.memberships, metrics.pendingInvitations,
		metrics.documents, metrics.revisions, metrics.schemaVersion,
		metrics.blobs, metrics.blobBytes, metrics.uploadSessions, metrics.uploadReserved, metrics.uploadOldestAge,
		metrics.gcPendingBlobs, metrics.gcPendingBytes, metrics.deletedVaults,
		metrics.rekeyVaults, metrics.staleRevisions, metrics.escrowVaults, metrics.escrowRewrapSlots,
		metrics.lastRetention, metrics.lastExport, metrics.lastSuccess,
	}
}

// Handler serves the metrics at GET /metrics, from a registry holding only
// them.
func (metrics *Metrics) Handler() http.Handler {
	registry := prometheus.NewRegistry()
	registry.MustRegister(metrics.Collectors()...)

	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))

	return mux
}

// Refresher refreshes Metrics from Store.
type Refresher struct {
	Store   Store
	Metrics *Metrics
	// QueryTimeout bounds each query; DefaultQueryTimeout when zero.
	QueryTimeout time.Duration
	// EscrowRetiringKeyIDs are the retiring escrow key ids whose slots
	// vault_sync_service_escrow_rewrap_slots counts.
	EscrowRetiringKeyIDs []string
	// BlobSampling bounds the blob estimate; store.DefaultBlobSampling when
	// zero.
	BlobSampling store.BlobSampling
	Logger       *slog.Logger
	// Now returns the current time; time.Now when nil.
	Now func() time.Time
}

// Run refreshes the metrics at once and then every interval until ctx is
// canceled.
func (refresher *Refresher) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		refresher.Refresh(ctx)

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Refresh runs every query once. Each query that succeeds sets its
// metrics; one that fails is logged and leaves them unchanged. The success
// timestamp advances only when every query succeeded. It reports whether
// they all did.
func (refresher *Refresher) Refresh(ctx context.Context) bool {
	metrics := refresher.Metrics

	now := time.Now
	if refresher.Now != nil {
		now = refresher.Now
	}

	sampling := refresher.BlobSampling
	if sampling == (store.BlobSampling{}) {
		sampling = store.DefaultBlobSampling
	}

	queries := []struct {
		name string
		run  func(ctx context.Context) error
	}{
		{"devices", func(ctx context.Context) error {
			counts, err := refresher.Store.CountDevices(ctx)
			if err == nil {
				metrics.devices.Set(float64(counts.Devices))
				metrics.usersWithDevices.Set(float64(counts.Users))
				metrics.activeDevicesDay.Set(float64(counts.ActiveDay))
				metrics.activeDevicesMonth.Set(float64(counts.ActiveMonth))
			}

			return err
		}},
		{"vaults", func(ctx context.Context) error {
			counts, err := refresher.Store.CountVaults(ctx)
			if err != nil {
				return err
			}

			values := map[[2]string]int64{}
			for _, count := range counts {
				values[[2]string{count.Encryption, strconv.FormatBool(count.Shared)}] += count.Count
			}

			for _, encryption := range encryptions {
				for _, shared := range sharing {
					key := [2]string{encryption, strconv.FormatBool(shared)}
					metrics.vaults.WithLabelValues(key[0], key[1]).Set(float64(values[key]))
				}
			}

			return nil
		}},
		{"memberships", func(ctx context.Context) error {
			count, err := refresher.Store.CountMemberships(ctx)
			if err == nil {
				metrics.memberships.Set(float64(count))
			}

			return err
		}},
		{"pending_invitations", func(ctx context.Context) error {
			count, err := refresher.Store.CountPendingInvitations(ctx)
			if err == nil {
				metrics.pendingInvitations.Set(float64(count))
			}

			return err
		}},
		{"row_estimates", func(ctx context.Context) error {
			estimates, err := refresher.Store.EstimateRows(ctx)
			if err == nil {
				metrics.documents.Set(float64(estimates.LiveDocuments))
				metrics.revisions.Set(float64(estimates.Revisions))
			}

			return err
		}},
		{"schema_version", func(ctx context.Context) error {
			version, err := refresher.Store.SchemaVersion(ctx)
			if err == nil {
				metrics.schemaVersion.Set(float64(version))
			}

			return err
		}},
		{"blobs", func(ctx context.Context) error {
			estimate, err := refresher.Store.EstimateBlobs(ctx, sampling)
			if err == nil {
				metrics.blobs.Set(float64(estimate.Blobs))
				metrics.blobBytes.Set(float64(estimate.Bytes))
			}

			return err
		}},
		{"upload_sessions", func(ctx context.Context) error {
			sessions, err := refresher.Store.CountUploadSessions(ctx)
			if err != nil {
				return err
			}

			metrics.uploadSessions.Set(float64(sessions.Open))
			metrics.uploadReserved.Set(float64(sessions.ReservedBytes))

			age := 0.0
			if !sessions.OldestCreatedAt.IsZero() {
				age = max(now().Sub(sessions.OldestCreatedAt).Seconds(), 0)
			}

			metrics.uploadOldestAge.Set(age)

			return nil
		}},
		{"gc_pending_blobs", func(ctx context.Context) error {
			counts, err := refresher.Store.CountReleasedBlobs(ctx)
			if err == nil {
				metrics.gcPendingBlobs.Set(float64(counts.Blobs))
				metrics.gcPendingBytes.Set(float64(counts.Bytes))
			}

			return err
		}},
		{"deleted_vaults", func(ctx context.Context) error {
			count, err := refresher.Store.CountDeletedVaults(ctx)
			if err == nil {
				metrics.deletedVaults.Set(float64(count))
			}

			return err
		}},
		{"stale_epoch_revisions", func(ctx context.Context) error {
			counts, err := refresher.Store.CountStaleEpochRevisions(ctx)
			if err == nil {
				metrics.rekeyVaults.Set(float64(counts.Vaults))
				metrics.staleRevisions.Set(float64(counts.Revisions))
			}

			return err
		}},
		{"escrow_vaults", func(ctx context.Context) error {
			counts, err := refresher.Store.CountEscrowVaults(ctx)
			if err == nil {
				metrics.escrowVaults.WithLabelValues("true").Set(float64(counts.On))
				metrics.escrowVaults.WithLabelValues("false").Set(float64(counts.Off))
			}

			return err
		}},
		{"escrow_rewrap_slots", func(ctx context.Context) error {
			count, err := refresher.Store.CountEscrowSlotsNamingKeys(ctx, refresher.EscrowRetiringKeyIDs)
			if err == nil {
				metrics.escrowRewrapSlots.Set(float64(count))
			}

			return err
		}},
		{"last_runs", func(ctx context.Context) error {
			runs, err := refresher.Store.LastRuns(ctx)
			if err == nil {
				metrics.lastRetention.Set(unixSeconds(runs.Retention))
				metrics.lastExport.Set(unixSeconds(runs.Export))
			}

			return err
		}},
	}

	timeout := refresher.QueryTimeout
	if timeout <= 0 {
		timeout = DefaultQueryTimeout
	}

	succeeded := true

	for _, query := range queries {
		if ctx.Err() != nil {
			return false
		}

		queryCtx, cancel := context.WithTimeout(ctx, timeout)
		err := query.run(queryCtx)

		cancel()

		if err != nil {
			succeeded = false

			if ctx.Err() == nil && refresher.Logger != nil {
				refresher.Logger.WarnContext(ctx, "service metrics query failed; keeping its previous values", "query", query.name, "error", err)
			}
		}
	}

	if succeeded {
		metrics.lastSuccess.Set(unixSeconds(now()))
	}

	return succeeded
}

// unixSeconds returns at as Unix seconds, or 0 for the zero time.
func unixSeconds(at time.Time) float64 {
	if at.IsZero() {
		return 0
	}

	return float64(at.UnixNano()) / float64(time.Second)
}
