package retention

import "github.com/prometheus/client_golang/prometheus"

// Metrics are the retention job's Prometheus metrics. Every server process
// counts its own runs' work: summed over replicas, the counters count each
// purge, collection and deletion once.
type Metrics struct {
	revisionsPurged prometheus.Counter
	blobsCollected  prometheus.Counter
	objectsDeleted  prometheus.Counter
	markersPruned   prometheus.Counter
	vaultsPurged    prometheus.Counter
	runFailures     prometheus.Counter
}

// NewMetrics returns unregistered retention metrics.
func NewMetrics() *Metrics {
	return &Metrics{
		revisionsPurged: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_retention_revisions_purged_total",
			Help: "Revisions this replica's retention job purged.",
		}),
		blobsCollected: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_retention_blobs_collected_total",
			Help: "Blobs no revision references whose rows this replica's retention job deleted.",
		}),
		objectsDeleted: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_retention_objects_deleted_total",
			Help: "Collected blobs' S3 objects this replica's retention job deleted.",
		}),
		markersPruned: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_retention_purge_markers_pruned_total",
			Help: "Purge markers older than VAULT_SYNC_RETENTION_PURGE_MARKER_HORIZON that this replica's retention job deleted. A run prunes at most 100,000: growth by that much every run means pruning is falling behind the purges.",
		}),
		vaultsPurged: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_retention_vaults_purged_total",
			Help: "Vaults deleted more than 30 days ago whose rows and S3 objects this replica's retention job purged.",
		}),
		runFailures: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_retention_run_failures_total",
			Help: "Retention runs on this replica that failed in part (logged as retention run failed); the next run retries. Alert if it keeps rising.",
		}),
	}
}

// Collectors returns the metrics, for registration.
func (metrics *Metrics) Collectors() []prometheus.Collector {
	return []prometheus.Collector{metrics.revisionsPurged, metrics.blobsCollected, metrics.objectsDeleted, metrics.markersPruned, metrics.vaultsPurged, metrics.runFailures}
}

// observe records one run.
func (metrics *Metrics) observe(result Result, failed bool) {
	if metrics == nil {
		return
	}

	metrics.revisionsPurged.Add(float64(result.RevisionsPurged))
	metrics.blobsCollected.Add(float64(result.BlobsCollected))
	metrics.objectsDeleted.Add(float64(result.ObjectsDeleted))
	metrics.markersPruned.Add(float64(result.MarkersPruned))
	metrics.vaultsPurged.Add(float64(result.VaultsPurged))

	if failed {
		metrics.runFailures.Inc()
	}
}
