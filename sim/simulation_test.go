//go:build sim

// Package sim_test is the driver of the sync simulation (SPEC.md §13): it
// starts a real vault-sync-server against PostgreSQL and the S3-compatible
// store, serves the harness's control endpoint, and runs the TypeScript
// harness in this directory with vitest. Run it with `make test-sim`
// (scripts/test-sim.sh), which starts the dependencies and sets the `sim`
// build tag.
package sim_test

import (
	"bytes"
	"debug/buildinfo"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// Environment variables through which the driver hands the server and the
// control endpoint to plugin/vitest.sim.config.ts.
const (
	serverURLEnv = "VAULT_SYNC_SIM_SERVER_URL"
	// limitedServerURLEnv is the replica with a small upload session limit.
	limitedServerURLEnv = "VAULT_SYNC_SIM_LIMITED_SERVER_URL"
	controlURLEnv       = "VAULT_SYNC_SIM_CONTROL_URL"
	suitesEnv           = "VAULT_SYNC_SIM_SUITES"
	shrinkRunsEnv       = "SIM_SHRINK_RUNS"
	// regressionDirEnv overrides where failing seeds are written and which
	// regression cases are replayed (default: sim/regressions, so they can be
	// committed). A relative value is relative to the repository root.
	regressionDirEnv = "SIM_REGRESSION_DIR"

	// limitedMaxUploadsPerVault is the limited replica's per-vault upload
	// session limit; sim/scenarios.ts (uploadLimitReached) relies on it.
	limitedMaxUploadsPerVault = 2

	// brokenShrinkRuns bounds minimization in the broken-server check,
	// which only needs to show that minimization works.
	brokenShrinkRuns = 40

	// invariantProtocol is the harness's violation of a protocol guarantee
	// a client observed (sim/client.ts, sim/network.ts).
	invariantProtocol = "protocol"
	// invariantRevokedWrite is the harness's violation of a write the
	// server accepted from a viewer or a removed member (sim/members.ts).
	invariantRevokedWrite = "revoked-write"
	// refusedRetryDetail is part of the protocol violation sim/network.ts
	// reports when the server refuses a retry of a revision it applied.
	refusedRetryDetail = "although the server already applied this revision id"

	// refusedEditScenario names the scripted #12 scenario in
	// sim/simulation.sim.test.ts: a commit of an edit whose response was
	// lost, retried after another client's commit moved the head.
	refusedEditScenario = "returns the committed revision when a commit whose response was lost is retried after the head moved"
)

// refusedEditPattern matches the network's refused-retry violation for a
// commit with a base revision (an edit or rename; a create's base is "-").
var refusedEditPattern = regexp.MustCompile(`CommitRevision\(\S+ \S+ base=[^-\s]\S* [^)]*\) was refused with FailedPrecondition, ` + refusedRetryDetail)

// brokenSchedule is the schedule the broken-server check always runs: the
// short run CI does on every pull request (SIM_SEEDS=5, SIM_STEPS=1000, the
// default three clients and two engines, on the faithful filesystem). It is pinned, not taken from the SIM_* tuning
// variables, so that replaying one seed or running shorter schedules locally
// cannot make the check fail, and so that it proves the CI run catches the
// broken server.
var brokenSchedule = []string{
	"SIM_SEED=",
	"SIM_FIRST_SEED=1",
	"SIM_SEEDS=5",
	"SIM_STEPS=1000",
	"SIM_CLIENTS=3",
	"SIM_ENGINES=2",
	"SIM_FAITHFUL_FS=",
}

// refusedRetrySchedule is the refused-retry detector's own pinned schedule:
// brokenSchedule without engine users (SIM_ENGINES=0), so one engine only
// pulls and the schedule has no engine-operation steps, the shape every
// seeded run had before #22. Since engine users joined CI's short run, its
// seeds no longer meet a commit retried after the head moved (follow-up
// #284), so the detector keeps the schedule it was proven on (#110),
// including the folded vault and its path pool that seeded runs used before
// refactor step R7 made the faithful filesystem the default.
var refusedRetrySchedule = []string{
	"SIM_SEED=",
	"SIM_FIRST_SEED=1",
	"SIM_SEEDS=5",
	"SIM_STEPS=1000",
	"SIM_CLIENTS=3",
	"SIM_ENGINES=0",
	"SIM_FAITHFUL_FS=0",
}

// simulation is a running server plus control endpoint.
type simulation struct {
	serverURL string
	// limitedServerURL is a second replica with a per-vault upload
	// session limit of limitedMaxUploadsPerVault.
	limitedServerURL string
	controlURL       string
	control          *control
	regressionDir    string
}

// startSimulation builds the server with the given build tags and starts it
// against a fresh database and bucket, plus the control endpoint.
func startSimulation(t *testing.T, regressionDir string, tags ...string) *simulation {
	t.Helper()

	database := testinfra.PostgresConfig(t)
	bucket := testinfra.S3Bucket(t)

	repoRoot, err := filepath.Abs("..")
	require.NoError(t, err)

	binary := testinfra.BuildServer(t, repoRoot, tags...)
	requireBuildTags(t, binary, tags)

	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)

	start := func(name string, extraEnv ...string) string {
		// Starts a new process, with new addresses, if another process took
		// one of the ports first.
		return testinfra.StartServer(t, name, 60*time.Second, func(addresses testinfra.ServerAddresses) testinfra.ServerProcess {
			logs := &bytes.Buffer{}
			server := testinfra.NewChild(t, binary)

			server.Command.Env = append([]string{
				config.DatabaseURLEnv + "=" + database.DSN,
				config.ListenAddressEnv + "=" + addresses.API,
				config.MetricsListenAddressEnv + "=" + addresses.Metrics,
				config.OIDCIssuerURLEnv + "=" + issuer.URL,
				config.OIDCAudienceEnv + "=" + authtest.DefaultAudience,
				config.S3EndpointEnv + "=" + bucket.Endpoint,
				config.S3RegionEnv + "=" + bucket.Region,
				config.S3BucketEnv + "=" + bucket.Bucket,
				config.S3AccessKeyIDFileEnv + "=" + bucket.AccessKeyIDFile,
				config.S3SecretAccessKeyFileEnv + "=" + bucket.SecretAccessKeyFile,
				config.S3ForcePathStyleEnv + "=true",
				// The smallest chunk size the server allows, so the occasional
				// large content is uploaded in several chunks.
				config.BlobMaxChunkBytesEnv + "=65536",
				config.LogLevelEnv + "=warn",
				// Stop at once when the test ends (#96).
				"VAULT_SYNC_SHUTDOWN_DELAY=0s",
			}, extraEnv...)
			server.Command.Stdout = logs
			server.Command.Stderr = logs

			t.Cleanup(func() {
				if t.Failed() {
					t.Logf("%s logs:\n%s", name, logs.String())
				}
			})

			server.Start(t)

			return testinfra.ServerProcess{Exited: server.Exited(), Err: server.Wait, Output: logs.String, PID: server.PID()}
		}).API
	}

	// Clients that crash or give up abandon upload sessions; a long run
	// must not hit the per-vault session limit.
	apiAddress := start("server", config.BlobMaxUploadsPerVaultEnv+"="+strconv.Itoa(config.MaxBlobMaxUploadsPerVault))
	// A second replica of the same server, on the same database and bucket
	// (SPEC.md §3: replicas are stateless and coordinate through PostgreSQL
	// only), with a small per-vault upload session limit, so that a scenario
	// can fill it and have idle sessions reclaimed (#490). It is started
	// after the first, which has migrated the database.
	limitedAddress := start("limited server",
		config.BlobMaxUploadsPerVaultEnv+"="+strconv.Itoa(limitedMaxUploadsPerVault),
		config.BlobUploadReclaimIdleEnv+"="+config.DefaultBlobUploadReclaimIdle.String())

	db, err := pgxpool.New(t.Context(), database.DSN)
	require.NoError(t, err)
	t.Cleanup(db.Close)

	deadline, hasDeadline := t.Deadline()
	ctl := &control{db: db, issuer: issuer, key: key, regressionDir: regressionDir, tokenExpiry: tokenExpiry(deadline, hasDeadline, time.Now())}
	controlServer := httptest.NewServer(ctl.handler())
	t.Cleanup(controlServer.Close)

	return &simulation{
		serverURL:        "http://" + apiAddress,
		limitedServerURL: "http://" + limitedAddress,
		controlURL:       controlServer.URL,
		control:          ctl,
		regressionDir:    regressionDir,
	}
}

// requireBuildTags checks the binary was built with exactly the requested
// tags, so the simulation never runs the broken build by accident (or the
// broken-server check the correct one).
func requireBuildTags(t *testing.T, binary string, tags []string) {
	t.Helper()

	info, err := buildinfo.ReadFile(binary)
	require.NoError(t, err)

	built := ""

	for _, setting := range info.Settings {
		if setting.Key == "-tags" {
			built = setting.Value
		}
	}

	require.Equal(t, strings.Join(tags, ","), built, "server build tags")
}

// suiteResult is the outcome of one vitest run of the harness.
type suiteResult struct {
	err    error
	output string
	total  int
	report vitestReport
}

// runSuite runs the harness's networked vitest suite against the
// simulation. Output is streamed to stdout when stream is set.
func (simulation *simulation) runSuite(t *testing.T, stream bool, extraEnv []string, extraArguments ...string) suiteResult {
	t.Helper()

	_, err := exec.LookPath("node")
	require.NoError(t, err, "Node.js is required to run the simulation; use `nix develop`")

	pluginDir, err := filepath.Abs(filepath.Join("..", "plugin"))
	require.NoError(t, err)

	// The locally installed vitest, never a package fetched by npx.
	vitest := filepath.Join(pluginDir, "node_modules", ".bin", "vitest")
	_, err = os.Stat(vitest)
	require.NoError(t, err, "plugin dependencies are not installed; run `make test-sim`, which installs them")

	report := filepath.Join(t.TempDir(), "report.json")

	arguments := append([]string{
		"run", "--config", "vitest.sim.config.ts",
		"--reporter", "default", "--reporter", "json", "--outputFile.json", report,
	}, extraArguments...)

	suite := testinfra.NewChild(t, vitest, arguments...)
	suite.Command.Dir = pluginDir

	suite.Command.Env = append(append(os.Environ(),
		serverURLEnv+"="+simulation.serverURL,
		limitedServerURLEnv+"="+simulation.limitedServerURL,
		controlURLEnv+"="+simulation.controlURL,
		regressionDirEnv+"="+simulation.regressionDir,
		"CI=1", // no watch mode, no interactive output
	), extraEnv...)

	var output bytes.Buffer

	writer := io.Writer(&output)
	if stream {
		writer = io.MultiWriter(&output, os.Stdout)
	}

	suite.Command.Stdout = writer
	suite.Command.Stderr = writer
	suite.Start(t)

	result := suiteResult{err: suite.Wait()}
	result.output = output.String()

	if raw, err := os.ReadFile(report); err == nil && json.Unmarshal(raw, &result.report) == nil {
		result.total = result.report.NumTotalTests
	}

	return result
}

// TestSimulation runs the seeded schedules (SIM_SEEDS, SIM_STEPS,
// SIM_CLIENTS), the committed regression cases, the scripted scenarios and
// the determinism check against the real server. A failing seed is
// minimized and written to sim/regressions/ (or SIM_REGRESSION_DIR), and the
// test fails naming it. VAULT_SYNC_SIM_SUITES runs only some of the suites.
func TestSimulation(t *testing.T) {
	repoRoot, err := filepath.Abs("..")
	require.NoError(t, err)

	regressionDir := resolveRegressionDir(os.Getenv(regressionDirEnv), repoRoot)

	simulation := startSimulation(t, regressionDir)
	result := simulation.runSuite(t, true, nil)

	for _, regression := range simulation.control.recorded() {
		// The targeted shrink (VAULT_SYNC_SIM_SUITES=shrink) writes its result on purpose.
		if os.Getenv(suitesEnv) == "shrink" {
			t.Logf("minimized case written to %s", filepath.Join(regressionDir, regression.Name+".json"))

			continue
		}

		t.Errorf("SIM FAILURE: seed %d violated %v; minimized to %s", regression.Seed, invariantsOf(regression.Violations),
			filepath.Join(regressionDir, regression.Name+".json"))
	}

	require.NoError(t, result.err, "simulation suite failed (see its output above)")
	// A subset selected with VAULT_SYNC_SIM_SUITES skips the other suites
	// on purpose; a full run skips nothing (#393).
	require.NoError(t, checkSuiteRun(result.report, os.Getenv(suitesEnv)))
}

// TestSimulationDetectsBrokenServer proves the harness has teeth (issue
// #15): against a server built with the `simfault` tag, which accepts
// commits against a stale base, the seeds of CI's short run (brokenSchedule)
// must report a stale-base violation.
func TestSimulationDetectsBrokenServer(t *testing.T) {
	// The broken-server checks run side by side, each against its own
	// server, database and bucket.
	t.Parallel()

	requireSeedsDetect(t, "simfault", "simfault-stale-base", "seeds", brokenSchedule, invariantStaleBase, "")
}

// TestSimulationDetectsRefusedRetry proves that random schedules, not only
// the scripted scenario, catch the #12 bug (#110): against a server built
// with the `simfault_retry` tag, which refuses a retry of a revision it
// already applied once the head moved past it, the seeds of
// refusedRetrySchedule must report the refused retry as a protocol
// violation. The server-side
// invariants all hold in that run; only the network sees the duplicate
// coming.
//
// The seeded case shows a refused create, which the scripted client flags
// on its own too. The #12 interleaving proper is a retried edit or rename
// whose document's head moved, which only the network's check sees: the
// scripted #12 scenario (an edit) must report it too (#273 item 2).
func TestSimulationDetectsRefusedRetry(t *testing.T) {
	t.Parallel()

	simulation := requireSeedsDetect(t, "simfault_retry", "simfault-refused-retry", "seeds", refusedRetrySchedule, invariantProtocol, refusedRetryDetail)

	scenario := simulation.runSuite(t, false, []string{suitesEnv + "=scenarios"}, "-t", refusedEditScenario)
	require.Error(t, scenario.err, "the #12 scenario passed against the simfault_retry server:\n%s", scenario.output)
	require.Positive(t, scenario.total, "the #12 scenario did not run:\n%s", scenario.output)
	require.Regexp(t, refusedEditPattern, scenario.output, "the #12 scenario failed without the refused retry of its edit:\n%s", scenario.output)
}

// TestSimulationDetectsViewerWrite proves that the members suite catches a
// server that lets a demoted member write (#35): against a server built
// with the `simfault_authz` tag, which accepts a viewer's writes, the
// committed simfault-viewer-write case and the seeds of CI's short run
// (brokenSchedule) with membership changes must report a revoked-write
// violation.
func TestSimulationDetectsViewerWrite(t *testing.T) {
	t.Parallel()

	requireSeedsDetect(t, "simfault_authz", "simfault-viewer-write", "members", brokenSchedule, invariantRevokedWrite, "")
}

// requireSeedsDetect builds the server with the broken build tag, replays
// the committed case committedCase (sim/regressions/<committedCase>.json)
// against it, runs schedule's seeds of the seeded suite against it until
// one fails, and requires a violation of invariant whose detail contains
// detail from each. The minimized case the harness wrote must reproduce it when
// replayed as a committed regression case. It returns the running
// simulation for further checks.
func requireSeedsDetect(t *testing.T, tag, committedCase, suite string, schedule []string, invariant, detail string) *simulation {
	t.Helper()

	simulation := startSimulation(t, t.TempDir(), tag)

	// The committed case must still reproduce against its broken build, or a
	// later harness change could have made it pass trivially (#273 item 3).
	committedDir := t.TempDir()
	raw, err := os.ReadFile(filepath.Join("regressions", committedCase+".json"))
	require.NoError(t, err, "the committed case of the %s server", tag)
	require.NoError(t, os.WriteFile(filepath.Join(committedDir, committedCase+".json"), raw, 0o600))

	committed := simulation.runSuite(t, false, []string{suitesEnv + "=regressions", regressionDirEnv + "=" + committedDir})
	require.Error(t, committed.err, "the committed case %s passed against the %s server:\n%s", committedCase, tag, committed.output)
	require.Contains(t, committed.output, committedCase+" keeps every invariant", "the committed case %s was not replayed:\n%s", committedCase, committed.output)
	require.Contains(t, committed.output, invariant, "the committed case %s failed for another reason:\n%s", committedCase, committed.output)
	require.Contains(t, committed.output, detail, "the committed case %s failed for another reason:\n%s", committedCase, committed.output)

	shrinkRuns := brokenShrinkRuns

	if raw := os.Getenv(shrinkRunsEnv); raw != "" {
		configured, err := strconv.Atoi(raw)
		require.NoError(t, err, shrinkRunsEnv)

		shrinkRuns = min(shrinkRuns, configured)
	}

	result := simulation.runSuite(t, false, append([]string{
		suitesEnv + "=" + suite,
		shrinkRunsEnv + "=" + strconv.Itoa(shrinkRuns),
	}, schedule...), "--bail", "1")

	require.Error(t, result.err, "the simulation passed against the %s server:\n%s", tag, result.output)

	reports := simulation.control.recorded()
	require.NotEmpty(t, reports, "the suite failed without reporting a violating seed:\n%s", result.output)

	detected := false

	for _, regression := range reports {
		var steps []json.RawMessage
		assert.NoError(t, json.Unmarshal(regression.Steps, &steps))
		t.Logf("seed %d against the %s server: %v, minimized to %d steps", regression.Seed, tag, invariantsOf(regression.Violations), len(steps))

		for _, found := range regression.Violations {
			detected = detected || (found.Invariant == invariant && strings.Contains(found.Detail, detail))
		}
	}

	require.True(t, detected, "no %s violation (%q) was reported:\n%s", invariant, detail, result.output)

	// The minimized case it wrote must reproduce the violation when replayed
	// as a committed regression case.
	replay := simulation.runSuite(t, false, []string{suitesEnv + "=regressions"})
	require.Error(t, replay.err, "the recorded regression case passed against the %s server:\n%s", tag, replay.output)
	require.Contains(t, replay.output, invariant, "the regression case failed for another reason:\n%s", replay.output)
	require.Contains(t, replay.output, detail, "the regression case failed for another reason:\n%s", replay.output)
	require.Positive(t, replay.total, "no regression case was replayed:\n%s", replay.output)

	return simulation
}

func invariantsOf(violations []violation) []string {
	var invariants []string

	for _, found := range violations {
		invariants = append(invariants, found.Invariant)
	}

	return invariants
}
