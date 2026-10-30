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
	blobs       store.BlobEstimate
	uploads     store.UploadSessions
	released    store.ReleasedBlobCounts
	deleted     int64
	stale       store.StaleEpochCounts
	escrow      store.EscrowCounts
	rewrap      int64
	err         error
	block       string

	// sampling and keyIDs record the arguments of the last call.
	sampling store.BlobSampling
	keyIDs   []string
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

func (fake *fakeStore) EstimateBlobs(ctx context.Context, sampling store.BlobSampling) (store.BlobEstimate, error) {
	fake.sampling = sampling
	if err := fake.fail(ctx, "blobs"); err != nil {
		return store.BlobEstimate{}, err
	}

	return fake.blobs, nil
}

func (fake *fakeStore) CountUploadSessions(ctx context.Context) (store.UploadSessions, error) {
	if err := fake.fail(ctx, "uploads"); err != nil {
		return store.UploadSessions{}, err
	}

	return fake.uploads, nil
}

func (fake *fakeStore) CountReleasedBlobs(ctx context.Context) (store.ReleasedBlobCounts, error) {
	if err := fake.fail(ctx, "released"); err != nil {
		return store.ReleasedBlobCounts{}, err
	}

	return fake.released, nil
}

func (fake *fakeStore) CountDeletedVaults(ctx context.Context) (int64, error) {
	return fake.deleted, fake.fail(ctx, "deleted")
}

func (fake *fakeStore) CountStaleEpochRevisions(ctx context.Context) (store.StaleEpochCounts, error) {
	if err := fake.fail(ctx, "stale"); err != nil {
		return store.StaleEpochCounts{}, err
	}

	return fake.stale, nil
}

func (fake *fakeStore) CountEscrowVaults(ctx context.Context) (store.EscrowCounts, error) {
	if err := fake.fail(ctx, "escrow"); err != nil {
		return store.EscrowCounts{}, err
	}

	return fake.escrow, nil
}

func (fake *fakeStore) CountEscrowSlotsNamingKeys(ctx context.Context, keyIDs []string) (int64, error) {
	fake.keyIDs = keyIDs

	return fake.rewrap, fake.fail(ctx, "rewrap")
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
		blobs:       store.BlobEstimate{Blobs: 400, Bytes: 1 << 20},
		uploads:     store.UploadSessions{Open: 3, ReservedBytes: 9000, OldestCreatedAt: time.Unix(1_800_000_000-90, 0)},
		released:    store.ReleasedBlobCounts{Blobs: 8, Bytes: 4096},
		deleted:     2,
		stale:       store.StaleEpochCounts{Vaults: 1, Revisions: 300},
		escrow:      store.EscrowCounts{On: 2, Off: 5},
		rewrap:      11,
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
		"vault_sync_service_blobs":                                          400,
		"vault_sync_service_blob_bytes":                                     1 << 20,
		"vault_sync_service_upload_sessions":                                3,
		"vault_sync_service_upload_session_reserved_bytes":                  9000,
		"vault_sync_service_upload_session_oldest_age_seconds":              90,
		"vault_sync_service_gc_pending_blobs":                               8,
		"vault_sync_service_gc_pending_blob_bytes":                          4096,
		"vault_sync_service_deleted_vaults":                                 2,
		"vault_sync_service_rekey_vaults":                                   1,
		"vault_sync_service_stale_epoch_revisions":                          300,
		`vault_sync_service_encrypted_vaults_by_escrow{escrow="true"}`:      2,
		`vault_sync_service_encrypted_vaults_by_escrow{escrow="false"}`:     5,
		"vault_sync_service_escrow_rewrap_slots":                            11,
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
	fake.blobs, fake.uploads, fake.released = store.BlobEstimate{}, store.UploadSessions{}, store.ReleasedBlobCounts{}
	fake.deleted, fake.rewrap = 0, 0
	fake.stale, fake.escrow = store.StaleEpochCounts{}, store.EscrowCounts{}
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
	want["vault_sync_service_upload_session_oldest_age_seconds"] = 150
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

func TestRefreshPassesTheRetiringKeyIDsAndBlobSampling(t *testing.T) {
	fake := populatedStore()
	refresher := &servicemetrics.Refresher{
		Store: fake, Metrics: servicemetrics.NewMetrics(), EscrowRetiringKeyIDs: []string{"old-1", "old-2"},
	}

	require.True(t, refresher.Refresh(t.Context()))
	assert.Equal(t, []string{"old-1", "old-2"}, fake.keyIDs)
	assert.Equal(t, store.BlobSampling{ExactBelow: 100_000, SamplePercent: 1}, fake.sampling)
}

func TestOldestUploadAgeIsZeroWithoutOpenSessions(t *testing.T) {
	metrics := servicemetrics.NewMetrics()
	fake := populatedStore()
	refresher := &servicemetrics.Refresher{Store: fake, Metrics: metrics, Now: func() time.Time { return time.Unix(1_800_000_000, 0) }}

	require.True(t, refresher.Refresh(t.Context()))

	fake.uploads = store.UploadSessions{}

	require.True(t, refresher.Refresh(t.Context()))
	assert.Zero(t, scrape(t, metrics.Handler())["vault_sync_service_upload_session_oldest_age_seconds"])
}
