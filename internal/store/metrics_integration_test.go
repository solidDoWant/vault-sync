//go:build integration

package store_test

import (
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// poolCollector returns the collector among metrics' collectors that
// describes the metric name.
func poolCollector(t *testing.T, metrics *store.Metrics, name string) prometheus.Collector {
	t.Helper()

	for _, collector := range metrics.Collectors() {
		descs := make(chan *prometheus.Desc, 1)
		collector.Describe(descs)

		if strings.Contains((<-descs).String(), `"`+name+`"`) {
			return collector
		}
	}

	require.Failf(t, "no collector", "%s", name)

	return nil
}

func TestPoolMetricsRecordConnectionsAcquiresAndQueryErrors(t *testing.T) {
	cfg := testinfra.PostgresConfig(t)

	dsn, err := url.Parse(cfg.DSN)
	require.NoError(t, err)

	query := dsn.Query()
	query.Set("pool_max_conns", "1")
	dsn.RawQuery = query.Encode()
	cfg.DSN = dsn.String()

	metrics := store.NewMetrics()
	cfg.Metrics = metrics
	pool := openPool(t, cfg)

	value := func(name string) float64 { return testutil.ToFloat64(poolCollector(t, metrics, name)) }

	assert.Zero(t, value("vault_sync_db_pool_acquired_connections"))
	assert.Equal(t, 1.0, value("vault_sync_db_pool_idle_connections"), "Open pinged over one connection")

	// No rows is not an error of the query.
	var one int
	require.ErrorIs(t, pool.QueryRow(t.Context(), "SELECT 1 WHERE false").Scan(&one), pgx.ErrNoRows)
	assert.Zero(t, value("vault_sync_db_query_errors_total"))

	_, err = pool.Exec(t.Context(), "SELECT * FROM no_such_table")
	require.Error(t, err)

	// Query reports an execution error once its rows are read.
	rows, err := pool.Query(t.Context(), "SELECT 1/0")
	require.NoError(t, err)
	rows.Close()
	require.Error(t, rows.Err())
	assert.Equal(t, 2.0, value("vault_sync_db_query_errors_total"))

	held, err := pool.Acquire(t.Context())
	require.NoError(t, err)

	// Released before the pool closes even if the test fails early.
	release := sync.OnceFunc(held.Release)
	t.Cleanup(release)

	assert.Equal(t, 1.0, value("vault_sync_db_pool_acquired_connections"))
	assert.Zero(t, value("vault_sync_db_pool_idle_connections"))
	assert.Zero(t, value("vault_sync_db_pool_waiting_acquires"))

	acquired := make(chan error, 1)

	go func() {
		waiter, err := pool.Acquire(t.Context())
		if err == nil {
			waiter.Release()
		}

		acquired <- err
	}()

	require.Eventually(t, func() bool { return value("vault_sync_db_pool_waiting_acquires") == 1 }, 10*time.Second, 10*time.Millisecond)

	release()
	require.NoError(t, <-acquired)

	assert.Zero(t, value("vault_sync_db_pool_waiting_acquires"))

	// Every Acquire was timed: Open's ping, the three queries and the two
	// above.
	assert.Equal(t, uint64(6), acquireCount(t, metrics))
}

// acquireCount returns the sample count of the acquire duration histogram.
func acquireCount(t *testing.T, metrics *store.Metrics) uint64 {
	t.Helper()

	registry := prometheus.NewPedanticRegistry()
	registry.MustRegister(poolCollector(t, metrics, "vault_sync_db_pool_acquire_duration_seconds"))

	families, err := registry.Gather()
	require.NoError(t, err)
	require.Len(t, families, 1)
	require.Len(t, families[0].GetMetric(), 1)

	return families[0].GetMetric()[0].GetHistogram().GetSampleCount()
}
