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
		lastSuccess: gauge("vault_sync_service_metrics_last_refresh_success_timestamp_seconds",
			"Unix time of the last refresh in which every service-wide query succeeded; 0 before the first. A failed query keeps its metrics' previous values."),
	}

	for _, encryption := range encryptions {
		for _, shared := range sharing {
			metrics.vaults.WithLabelValues(encryption, strconv.FormatBool(shared))
		}
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
		metrics.documents, metrics.revisions, metrics.schemaVersion, metrics.lastSuccess,
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
		now := time.Now
		if refresher.Now != nil {
			now = refresher.Now
		}

		metrics.lastSuccess.Set(float64(now().UnixNano()) / float64(time.Second))
	}

	return succeeded
}
