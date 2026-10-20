//go:build integration

package retentioncmd_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/retentioncmd"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// The deployment-wide policy of these tests: the default.
var deployment = store.RetentionPolicy{KeepAll: 90 * 24 * time.Hour, KeepDaily: 365 * 24 * time.Hour}

type fixture struct {
	cfg          store.Config
	pool         *pgxpool.Pool
	store        *store.Store
	user, device uuid.UUID
	// env is the subcommand's environment.
	env map[string]string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()

	cfg := testinfra.PostgresConfig(t)

	pool, err := store.Open(t.Context(), cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	queries := store.New(pool)

	user, err := queries.UpsertUser(t.Context(), "https://issuer.example", "alice")
	require.NoError(t, err)

	device, err := queries.RegisterDevice(t.Context(), user, "laptop", nil, 10)
	require.NoError(t, err)

	return &fixture{
		cfg: cfg, pool: pool, store: queries, user: user, device: device.ID,
		env: map[string]string{config.DatabaseURLEnv: cfg.DSN},
	}
}

// run runs the subcommand with args and returns its exit code and output.
func (fixture *fixture) run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()

	var stdout, stderr bytes.Buffer

	lookup := func(name string) (string, bool) {
		value, ok := fixture.env[name]

		return value, ok
	}

	code := retentioncmd.Main(t.Context(), args, lookup, &stdout, &stderr)

	return code, stdout.String(), stderr.String()
}

// mustRun runs the subcommand and requires it to succeed.
func (fixture *fixture) mustRun(t *testing.T, args ...string) string {
	t.Helper()

	code, stdout, stderr := fixture.run(t, args...)
	require.Equal(t, 0, code, "stderr: %s", stderr)

	return stdout
}

// vault creates a vault with two documents, each with two revisions on one
// UTC day (50 and 100 days ago) and a head now: of each pair, the older is
// purged once the day is past the vault's KeepAll.
func (fixture *fixture) vault(t *testing.T, name string) uuid.UUID {
	t.Helper()

	vault, err := fixture.store.CreateVault(t.Context(), fixture.user, store.NewVault{Name: name, Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	for _, document := range []struct{ path, day string }{
		{"fifty.md", `date_trunc('day', now() - interval '50 days', 'UTC')`},
		{"hundred.md", `date_trunc('day', now() - interval '100 days', 'UTC')`},
	} {
		fixture.document(t, vault.ID, document.path,
			document.day+` + interval '1 hour'`, document.day+` + interval '2 hours'`, `now()`)
	}

	return vault.ID
}

// document commits a document at path with one revision per SQL time.
func (fixture *fixture) document(t *testing.T, vaultID uuid.UUID, path string, created ...string) {
	t.Helper()

	sum := sha256.Sum256([]byte(path))

	_, err := fixture.pool.Exec(t.Context(), `INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, $3, 'complete')`,
		vaultID, sum[:], len(path))
	require.NoError(t, err)

	documentID := uuid.Must(uuid.NewV7())

	var base uuid.NullUUID

	for _, at := range created {
		committed, err := fixture.store.InVault(vaultID).CommitRevision(t.Context(), store.NewRevision{
			ID: uuid.Must(uuid.NewV7()), DocumentID: documentID, BaseRevID: base, Kind: "text",
			ContentRef: sum[:], ContentSize: int64(len(path)), Path: path, PathKey: path,
			DeviceID: fixture.device, UserID: fixture.user,
		})
		require.NoError(t, err)

		_, err = fixture.pool.Exec(t.Context(), `UPDATE revisions SET created_at = `+at+` WHERE id = $1`, committed.ID)
		require.NoError(t, err)

		base = uuid.NullUUID{UUID: committed.ID, Valid: true}
	}
}

// revisions counts each document's revisions in vaultID, by path.
func (fixture *fixture) revisions(t *testing.T, vaultID uuid.UUID) map[string]int {
	t.Helper()

	rows, err := fixture.pool.Query(t.Context(), `SELECT path, count(*) FROM revisions WHERE vault_id = $1 GROUP BY path`, vaultID)
	require.NoError(t, err)

	defer rows.Close()

	counts := map[string]int{}

	for rows.Next() {
		var (
			path  string
			count int
		)

		require.NoError(t, rows.Scan(&path, &count))
		counts[path] = count
	}

	require.NoError(t, rows.Err())

	return counts
}

func (fixture *fixture) job() *retention.Job {
	return &retention.Job{Store: fixture.store, Policy: deployment, Grace: time.Hour}
}

// runJob runs the retention job once and returns how many revisions it
// purged.
func (fixture *fixture) runJob(t *testing.T) int {
	t.Helper()

	result, err := fixture.job().RunOnce(t.Context())
	require.NoError(t, err)

	return result.RevisionsPurged
}

var (
	kept    = map[string]int{"fifty.md": 3, "hundred.md": 3}
	thinned = map[string]int{"fifty.md": 3, "hundred.md": 2}
	short   = map[string]int{"fifty.md": 2, "hundred.md": 2}
)

// Issue #468 criterion 1: a vault with an override set through the
// subcommand is purged per the override, and every other vault per the
// deployment-wide policy; an override set after a complete scan applies
// from the next run.
func TestRetentionOverrideAppliesToItsVaultOnly(t *testing.T) {
	fixture := newFixture(t)

	shorter := fixture.vault(t, "shorter")
	longer := fixture.vault(t, "longer")
	deployed := fixture.vault(t, "deployment-wide")
	later := fixture.vault(t, "overridden after a scan")

	fixture.mustRun(t, "set", "-vault", shorter.String(), "-keep-all", "720h", "-keep-daily", "8760h")
	fixture.mustRun(t, "set", "-vault", longer.String(), "-keep-all", "4800h", "-keep-daily", "8760h")

	assert.Equal(t, 4, fixture.runJob(t))
	assert.Equal(t, short, fixture.revisions(t, shorter), "30 days: both pairs are thinned")
	assert.Equal(t, kept, fixture.revisions(t, longer), "200 days: everything is kept")
	assert.Equal(t, thinned, fixture.revisions(t, deployed), "90 days: the pair 100 days old is thinned")
	assert.Equal(t, thinned, fixture.revisions(t, later), "90 days: the pair 100 days old is thinned")

	// The scan was complete, and no revision crossed an age since: only
	// the new override makes the pair 50 days old purgeable.
	fixture.mustRun(t, "set", "-vault", later.String(), "-keep-all", "720h", "-keep-daily", "8760h")

	assert.Equal(t, 1, fixture.runJob(t))
	assert.Equal(t, short, fixture.revisions(t, later))
	assert.Equal(t, thinned, fixture.revisions(t, deployed))
	assert.Equal(t, kept, fixture.revisions(t, longer))

	assert.Equal(t, 0, fixture.runJob(t))
}

// Issue #468 criterion 2: once its override is removed, a vault follows the
// deployment-wide policy again, even though the last scan was complete.
func TestRemovedRetentionOverrideFallsBackToTheDeploymentPolicy(t *testing.T) {
	fixture := newFixture(t)

	vault := fixture.vault(t, "longer")
	other := fixture.vault(t, "deployment-wide")

	fixture.mustRun(t, "set", "-vault", vault.String(), "-keep-all", "4800h", "-keep-daily", "8760h")

	assert.Equal(t, 1, fixture.runJob(t))
	assert.Equal(t, kept, fixture.revisions(t, vault))
	assert.Equal(t, 0, fixture.runJob(t), "the scan is complete")

	var removed retentioncmd.Override
	require.NoError(t, json.Unmarshal([]byte(fixture.mustRun(t, "unset", "-vault", vault.String())), &removed))
	require.NotNil(t, removed.Removed)
	assert.True(t, *removed.Removed)

	assert.Empty(t, fixture.mustRun(t, "list"))

	assert.Equal(t, 1, fixture.runJob(t))
	assert.Equal(t, thinned, fixture.revisions(t, vault))
	assert.Equal(t, thinned, fixture.revisions(t, other))

	// Removing it again changes nothing.
	require.NoError(t, json.Unmarshal([]byte(fixture.mustRun(t, "unset", "-vault", vault.String())), &removed))
	assert.False(t, *removed.Removed)
}

// HA: every replica runs the job at about the same time; together they
// apply an override exactly once.
func TestRetentionOverrideIsAppliedOnceByConcurrentReplicas(t *testing.T) {
	fixture := newFixture(t)

	shorter := fixture.vault(t, "shorter")
	deployed := fixture.vault(t, "deployment-wide")

	fixture.mustRun(t, "set", "-vault", shorter.String(), "-keep-all", "720h", "-keep-daily", "8760h")

	const replicas = 3

	var (
		wait   sync.WaitGroup
		mutex  sync.Mutex
		purged int
	)

	for range replicas {
		pool, err := store.Open(t.Context(), fixture.cfg)
		require.NoError(t, err)
		t.Cleanup(pool.Close)

		job := &retention.Job{Store: store.New(pool), Policy: deployment, Grace: time.Hour}

		wait.Go(func() {
			result, err := job.RunOnce(t.Context())
			assert.NoError(t, err)

			mutex.Lock()
			purged += result.RevisionsPurged
			mutex.Unlock()
		})
	}

	wait.Wait()

	assert.Equal(t, 3, purged)
	assert.Equal(t, short, fixture.revisions(t, shorter))
	assert.Equal(t, thinned, fixture.revisions(t, deployed))
}

// Issue #468 criterion 3: the subcommand refuses an override below the
// operator's minimums, or below the built-in floor without one, and
// accepts one exactly at them.
func TestRetentionSetRefusesOverridesBelowTheMinimum(t *testing.T) {
	fixture := newFixture(t)
	vault := fixture.vault(t, "notes")

	tests := []struct {
		name               string
		env                map[string]string
		keepAll, keepDaily string
		// wantRefusal is a substring of the refusal; empty means accepted.
		wantRefusal string
	}{
		{name: "the built-in floor of a day", keepAll: "24h", keepDaily: "24h"},
		{name: "below the built-in floor", keepAll: "23h59m59.999999s", keepDaily: "24h", wantRefusal: "-keep-all 23h59m59.999999s is below the minimum 24h0m0s"},
		{
			name: "at the operator's minimums", env: map[string]string{
				config.RetentionOverrideMinKeepAllEnv: "720h", config.RetentionOverrideMinKeepDailyEnv: "2160h",
			},
			keepAll: "720h", keepDaily: "2160h",
		},
		{
			name: "keep-all below the operator's minimum", env: map[string]string{config.RetentionOverrideMinKeepAllEnv: "720h"},
			keepAll: "719h59m59.999999s", keepDaily: "2160h", wantRefusal: config.RetentionOverrideMinKeepAllEnv,
		},
		{
			name: "keep-daily below the operator's minimum", env: map[string]string{config.RetentionOverrideMinKeepDailyEnv: "2160h"},
			keepAll: "720h", keepDaily: "2159h59m59.999999s", wantRefusal: config.RetentionOverrideMinKeepDailyEnv,
		},
		{name: "keep-daily below keep-all", keepAll: "720h", keepDaily: "719h59m59.999999s", wantRefusal: "-keep-daily 719h59m59.999999s is below -keep-all 720h0m0s"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture.mustRun(t, "unset", "-vault", vault.String())

			fixture.env = map[string]string{config.DatabaseURLEnv: fixture.cfg.DSN}
			for name, value := range test.env {
				fixture.env[name] = value
			}

			code, stdout, stderr := fixture.run(t, "set", "-vault", vault.String(), "-keep-all", test.keepAll, "-keep-daily", test.keepDaily)

			if test.wantRefusal != "" {
				assert.Equal(t, 1, code)
				assert.Contains(t, stderr, test.wantRefusal)
				assert.Empty(t, fixture.mustRun(t, "list"), "nothing is stored")

				return
			}

			require.Equal(t, 0, code, "stderr: %s", stderr)

			var stored retentioncmd.Override
			require.NoError(t, json.Unmarshal([]byte(fixture.mustRun(t, "list")), &stored))
			assert.Equal(t, vault, stored.VaultID)

			keepAll, err := time.ParseDuration(test.keepAll)
			require.NoError(t, err)
			keepDaily, err := time.ParseDuration(test.keepDaily)
			require.NoError(t, err)

			assert.Equal(t, keepAll.String(), stored.KeepAll)
			assert.Equal(t, keepDaily.String(), stored.KeepDaily)

			var printed retentioncmd.Override
			require.NoError(t, json.Unmarshal([]byte(stdout), &printed))
			assert.Equal(t, retentioncmd.Override{VaultID: vault, KeepAll: stored.KeepAll, KeepDaily: stored.KeepDaily}, printed)
		})
	}
}

// The subcommand refuses a vault that does not exist and malformed
// arguments, and stores nothing.
func TestRetentionCommandRefusesBadArguments(t *testing.T) {
	fixture := newFixture(t)
	vault := fixture.vault(t, "notes")

	tests := []struct {
		name     string
		args     []string
		wantCode int
	}{
		{name: "an unknown vault", args: []string{"set", "-vault", uuid.NewString(), "-keep-all", "720h", "-keep-daily", "8760h"}, wantCode: 1},
		{name: "no subcommand", wantCode: 2},
		{name: "an unknown subcommand", args: []string{"purge", "-vault", vault.String()}, wantCode: 2},
		{name: "set without keep-daily", args: []string{"set", "-vault", vault.String(), "-keep-all", "720h"}, wantCode: 2},
		{name: "set without a vault", args: []string{"set", "-keep-all", "720h", "-keep-daily", "8760h"}, wantCode: 2},
		{name: "a malformed vault ID", args: []string{"set", "-vault", "notes", "-keep-all", "720h", "-keep-daily", "8760h"}, wantCode: 2},
		{name: "a malformed duration", args: []string{"set", "-vault", vault.String(), "-keep-all", "30d", "-keep-daily", "8760h"}, wantCode: 2},
		{name: "unset with durations", args: []string{"unset", "-vault", vault.String(), "-keep-all", "720h"}, wantCode: 2},
		{name: "list with a vault", args: []string{"list", "-vault", vault.String()}, wantCode: 2},
		{name: "extra arguments", args: []string{"list", "more"}, wantCode: 2},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, stdout, stderr := fixture.run(t, test.args...)
			assert.Equal(t, test.wantCode, code)
			assert.Empty(t, stdout)
			assert.NotEmpty(t, stderr)
			assert.Empty(t, fixture.mustRun(t, "list"), "nothing is stored")
		})
	}
}

// After a complete scan, a run only considers documents with revisions that
// crossed an age since; in a vault with an override, its own ages.
func TestOverriddenAgesAreScannedIncrementally(t *testing.T) {
	fixture := newFixture(t)
	vault := fixture.vault(t, "shorter")

	fixture.mustRun(t, "set", "-vault", vault.String(), "-keep-all", "720h", "-keep-daily", "4320h")

	assert.Equal(t, 2, fixture.runJob(t))
	assert.Equal(t, 0, fixture.runJob(t), "the scan is complete")

	// Revisions that crossed the override's KeepAll (30 days) just after
	// the last scan started.
	crossed := `(SELECT scanned_through FROM retention_scans) - interval '30 days'`
	fixture.document(t, vault, "crossed.md", crossed, crossed+` + interval '1 microsecond'`, `now()`)

	assert.Equal(t, 1, fixture.runJob(t), "the revision that crossed the override's KeepAll is purged")

	// A revision crossing the override's KeepDaily (180 days) joins a
	// weekly bucket.
	weekly := `(SELECT scanned_through FROM retention_scans) - interval '180 days'`
	fixture.document(t, vault, "weekly.md", weekly+` - interval '1 microsecond'`, weekly, `now()`)

	assert.Equal(t, 1, fixture.runJob(t), "the revision whose bucket partner crossed the override's KeepDaily is purged")
}

// weekVault creates a vault with two documents, each with two revisions on
// different UTC days (Monday and Tuesday) of one ISO week and a head now:
// "older.md" in the week of 500 days ago, between the deployment-wide
// KeepDaily (365 days) and 730 days, and "newer.md" in the week of 250 days
// ago, between 180 days and the deployment-wide KeepDaily. A vault whose
// KeepDaily is past a pair keeps both (one per day); one whose KeepDaily is
// not purges the Monday one (one per week).
func (fixture *fixture) weekVault(t *testing.T, name string) uuid.UUID {
	t.Helper()

	vault, err := fixture.store.CreateVault(t.Context(), fixture.user, store.NewVault{Name: name, Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	for _, document := range []struct{ path, week string }{
		{"older.md", `date_trunc('week', now() - interval '500 days', 'UTC')`},
		{"newer.md", `date_trunc('week', now() - interval '250 days', 'UTC')`},
	} {
		fixture.document(t, vault.ID, document.path,
			document.week+` + interval '1 hour'`, document.week+` + interval '1 day 1 hour'`, `now()`)
	}

	return vault.ID
}

// Issue #468 criterion 1: an override's KeepDaily, not the deployment-wide
// one, decides which of a vault's revisions are thinned to one per UTC day
// and which to one per ISO week.
func TestRetentionOverrideKeepDailyDecidesDailyAndWeeklyThinning(t *testing.T) {
	fixture := newFixture(t)

	longer := fixture.weekVault(t, "keep-daily of two years")
	shorter := fixture.weekVault(t, "keep-daily of 180 days")
	deployed := fixture.weekVault(t, "deployment-wide")

	fixture.mustRun(t, "set", "-vault", longer.String(), "-keep-all", "720h", "-keep-daily", "17520h")
	fixture.mustRun(t, "set", "-vault", shorter.String(), "-keep-all", "720h", "-keep-daily", "4320h")

	assert.Equal(t, 3, fixture.runJob(t))
	assert.Equal(t, map[string]int{"older.md": 3, "newer.md": 3}, fixture.revisions(t, longer),
		"730 days: both pairs are daily, one revision per day is kept")
	assert.Equal(t, map[string]int{"older.md": 2, "newer.md": 2}, fixture.revisions(t, shorter),
		"180 days: both pairs are weekly, one revision per week is kept")
	assert.Equal(t, map[string]int{"older.md": 2, "newer.md": 3}, fixture.revisions(t, deployed),
		"365 days: only the pair 500 days old is weekly")
	assert.Equal(t, 0, fixture.runJob(t))
}

// Once a run under changed overrides completed, the next run is incremental
// again: it does not consider a document whose revisions crossed no age
// since that run started.
func TestRunAfterAnOverrideChangeIsIncrementalAgain(t *testing.T) {
	fixture := newFixture(t)

	vault := fixture.vault(t, "overridden")
	other := fixture.vault(t, "deployment-wide")

	assert.Equal(t, 2, fixture.runJob(t), "a full scan under no override")

	fixture.mustRun(t, "set", "-vault", vault.String(), "-keep-all", "720h", "-keep-daily", "8760h")

	assert.Equal(t, 1, fixture.runJob(t), "a full scan under the changed overrides")

	// A purgeable pair that crossed every age long before the last scan
	// started, as if it had been missed: only a full scan finds it.
	day := `date_trunc('day', now() - interval '100 days', 'UTC')`
	fixture.document(t, other, "missed.md", day+` + interval '1 hour'`, day+` + interval '2 hours'`, `now()`)

	assert.Equal(t, 0, fixture.runJob(t), "the run is incremental")
	assert.Equal(t, 3, fixture.revisions(t, other)["missed.md"])
}
