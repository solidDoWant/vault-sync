package servicemetrics_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/servicemetrics"
	"github.com/solidDoWant/vault-sync/internal/store"
)

var errDatabase = errors.New("database unreachable")

// fakeStore returns fixed values, or err from every query when set. A
// query named in block waits until its context ends.
type fakeStore struct {
	devices     store.DeviceCounts
	vaults      []store.VaultCount
	memberships int64
	invitations int64
	estimates   store.RowEstimates
	version     int64
	err         error
	block       string
}

func (fake *fakeStore) fail(ctx context.Context, query string) error {
	if fake.block == query {
		<-ctx.Done()

		return ctx.Err()
	}

	return fake.err
}

func (fake *fakeStore) CountDevices(ctx context.Context) (store.DeviceCounts, error) {
	if err := fake.fail(ctx, "devices"); err != nil {
		return store.DeviceCounts{}, err
	}

	return fake.devices, nil
}

func (fake *fakeStore) CountVaults(ctx context.Context) ([]store.VaultCount, error) {
	if err := fake.fail(ctx, "vaults"); err != nil {
		return nil, err
	}

	return fake.vaults, nil
}

func (fake *fakeStore) CountMemberships(ctx context.Context) (int64, error) {
	return fake.memberships, fake.fail(ctx, "memberships")
}

func (fake *fakeStore) CountPendingInvitations(ctx context.Context) (int64, error) {
	return fake.invitations, fake.fail(ctx, "invitations")
}

func (fake *fakeStore) EstimateRows(ctx context.Context) (store.RowEstimates, error) {
	if err := fake.fail(ctx, "estimates"); err != nil {
		return store.RowEstimates{}, err
	}

	return fake.estimates, nil
}

func (fake *fakeStore) SchemaVersion(ctx context.Context) (int64, error) {
	return fake.version, fake.fail(ctx, "version")
}

// scrape returns every sample served at /metrics, keyed by its series
// (the metric name and its labels, as exposed).
func scrape(t *testing.T, handler http.Handler) map[string]float64 {
	t.Helper()

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/metrics", nil))
	require.Equal(t, http.StatusOK, recorder.Code)

	samples := map[string]float64{}

	for line := range strings.Lines(recorder.Body.String()) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		series, raw, found := strings.Cut(line, " ")
		require.True(t, found, "malformed sample %q", line)

		value, err := strconv.ParseFloat(raw, 64)
		require.NoError(t, err, "malformed sample %q", line)

		samples[series] = value
	}

	return samples
}

func populatedStore() *fakeStore {
	return &fakeStore{
		devices: store.DeviceCounts{Devices: 7, Users: 4, ActiveDay: 2, ActiveMonth: 5},
		vaults: []store.VaultCount{
			{Encryption: "none", Shared: false, Count: 10},
			{Encryption: "none", Shared: true, Count: 3},
			{Encryption: "e2ee", Shared: true, Count: 2},
		},
		memberships: 21,
		invitations: 6,
		estimates:   store.RowEstimates{LiveDocuments: 1000, Revisions: 5000},
		version:     27,
	}
}

func populatedSamples(refreshed time.Time) map[string]float64 {
	return map[string]float64{
		"vault_sync_service_devices":                                        7,
		"vault_sync_service_users_with_devices":                             4,
		"vault_sync_service_active_devices_24h":                             2,
		"vault_sync_service_active_devices_30d":                             5,
		`vault_sync_service_vaults{encryption="none",shared="false"}`:       10,
		`vault_sync_service_vaults{encryption="none",shared="true"}`:        3,
		`vault_sync_service_vaults{encryption="e2ee",shared="false"}`:       0,
		`vault_sync_service_vaults{encryption="e2ee",shared="true"}`:        2,
		"vault_sync_service_vault_memberships":                              21,
		"vault_sync_service_pending_invitations":                            6,
		"vault_sync_service_live_documents_approximate":                     1000,
		"vault_sync_service_revisions_approximate":                          5000,
		"vault_sync_service_schema_version":                                 27,
		"vault_sync_service_metrics_last_refresh_success_timestamp_seconds": float64(refreshed.Unix()),
	}
}

func TestRefreshServesEveryQueryResult(t *testing.T) {
	metrics := servicemetrics.NewMetrics()
	refreshed := time.Unix(1_800_000_000, 0)
	refresher := &servicemetrics.Refresher{Store: populatedStore(), Metrics: metrics, Now: func() time.Time { return refreshed }}

	assert.True(t, refresher.Refresh(t.Context()))
	assert.Equal(t, populatedSamples(refreshed), scrape(t, metrics.Handler()))
}

func TestFailedRefreshKeepsTheLastValues(t *testing.T) {
	metrics := servicemetrics.NewMetrics()
	fake := populatedStore()
	refreshed := time.Unix(1_800_000_000, 0)
	now := refreshed
	refresher := &servicemetrics.Refresher{Store: fake, Metrics: metrics, Now: func() time.Time { return now }}

	require.True(t, refresher.Refresh(t.Context()))

	// Every query now fails, with different values behind them.
	fake.devices = store.DeviceCounts{}
	fake.vaults = nil
	fake.memberships, fake.invitations, fake.version = 0, 0, 0
	fake.estimates = store.RowEstimates{}
	fake.err = errDatabase
	now = refreshed.Add(time.Minute)

	assert.False(t, refresher.Refresh(t.Context()))
	assert.Equal(t, populatedSamples(refreshed), scrape(t, metrics.Handler()))
}

func TestFailedQueryKeepsOnlyItsValues(t *testing.T) {
	metrics := servicemetrics.NewMetrics()
	fake := populatedStore()
	refreshed := time.Unix(1_800_000_000, 0)
	refresher := &servicemetrics.Refresher{
		Store: fake, Metrics: metrics, QueryTimeout: 10 * time.Millisecond,
		Now: func() time.Time { return refreshed },
	}

	require.True(t, refresher.Refresh(t.Context()))

	// The memberships query times out; the others return new values.
	fake.block = "memberships"
	fake.memberships = 99
	fake.version = 28
	refresher.Now = func() time.Time { return refreshed.Add(time.Minute) }

	assert.False(t, refresher.Refresh(t.Context()))

	want := populatedSamples(refreshed)
	want["vault_sync_service_schema_version"] = 28
	assert.Equal(t, want, scrape(t, metrics.Handler()))
}

func TestHandlerServesOnlyServiceMetrics(t *testing.T) {
	handler := servicemetrics.NewMetrics().Handler()

	samples := scrape(t, handler)
	assert.NotEmpty(t, samples)

	for series := range samples {
		assert.Regexp(t, `^vault_sync_service_`, series)
	}

	for _, path := range []string{"/healthz", "/readyz"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		assert.Equal(t, http.StatusNotFound, recorder.Code, path)
	}
}
