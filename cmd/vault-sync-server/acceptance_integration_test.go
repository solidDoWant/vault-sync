//go:build integration

package main_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// The loopback URL through which the AC-22 suite asks this test to snapshot
// and restore the deployment (POST /snapshot, POST /restore).
const acceptanceControlURLEnv = "VAULT_SYNC_IT_CONTROL_URL"

// TestAC22OfflineRestore runs plugin/test/acceptance/restore.acceptance.test.ts:
// a device syncs, the operator snapshots PostgreSQL and S3 with the server
// stopped, the device syncs more, and the operator restores the snapshot with
// the server stopped and starts it again. The device reaches the server
// through a proxy at a fixed address, as through a load balancer.
func TestAC22OfflineRestore(t *testing.T) {
	cluster := newDeployment(t)
	binary := buildServer(t)
	server := cluster.start(t, "server", binary)

	var target atomic.Pointer[url.URL]

	setTarget := func(server *instance) {
		parsed, err := url.Parse(server.apiURL)
		require.NoError(t, err)
		target.Store(parsed)
	}
	setTarget(server)

	proxy := serveLoopback(t, &httputil.ReverseProxy{Rewrite: func(request *httputil.ProxyRequest) {
		request.SetURL(target.Load())
	}})

	// The control handler hands each request to the test goroutine, which
	// does the work (with require) and sends the reply back.
	type controlRequest struct {
		action string
		done   chan error
	}

	requests := make(chan controlRequest)
	control := serveLoopback(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			http.Error(writer, "POST only", http.StatusMethodNotAllowed)

			return
		}

		done := make(chan error, 1)
		select {
		case requests <- controlRequest{action: request.URL.Path, done: done}:
		case <-request.Context().Done():
			return
		}

		if err := <-done; err != nil {
			http.Error(writer, err.Error(), http.StatusInternalServerError)
		}
	}))

	snapshot := newDeploymentSnapshot(t, cluster)
	generation := 0

	suite := startAcceptanceSuite(t, "restore", proxy, cluster.token(t, "alice"), acceptanceControlURLEnv+"="+control)

	for {
		select {
		case request := <-requests:
			stopInstance(t, server)

			switch request.action {
			case "/snapshot":
				snapshot.take(t)
			case "/restore":
				snapshot.restore(t)
			default:
				request.done <- errors.New("unknown action " + request.action)

				continue
			}

			generation++
			server = cluster.start(t, "server-"+string(rune('a'+generation)), binary)
			setTarget(server)

			request.done <- nil
		case <-suite.exited:
			suite.check(t)

			return
		}
	}
}

// TestAC25Convergence runs plugin/test/acceptance/convergence.acceptance.test.ts:
// three devices make seeded random changes against the server and must
// converge on its heads.
func TestAC25Convergence(t *testing.T) {
	cluster := newDeployment(t)
	server := cluster.start(t, "server", buildServer(t))

	suite := startAcceptanceSuite(t, "convergence", server.apiURL, cluster.token(t, "alice"), "VAULT_SYNC_AC25_SEED="+os.Getenv("VAULT_SYNC_AC25_SEED"))
	<-suite.exited
	suite.check(t)
}

// serveLoopback serves handler on a free loopback port until the test ends
// and returns its base URL.
func serveLoopback(t *testing.T, handler http.Handler) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	httpServer := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = httpServer.Serve(listener) }()

	t.Cleanup(func() { _ = httpServer.Close() })

	return "http://" + listener.Addr().String()
}

// stopInstance stops the server gracefully (SIGTERM) and waits for it to
// exit, as an operator stops it before a snapshot or a restore.
func stopInstance(t *testing.T, server *instance) {
	t.Helper()

	require.NoError(t, server.process.Command.Process.Signal(syscall.SIGTERM))
	<-server.process.Exited()
}

// deploymentSnapshot is an offline copy of the deployment's PostgreSQL
// database (a template database) and S3 bucket (the objects, in memory).
type deploymentSnapshot struct {
	cluster  *deployment
	admin    string
	database string
	template string
	objects  *blobstore.Objects
	saved    map[string][]byte
}

func newDeploymentSnapshot(t *testing.T, cluster *deployment) *deploymentSnapshot {
	t.Helper()

	databaseURL, err := url.Parse(cluster.database.DSN)
	require.NoError(t, err)

	database := filepath.Base(databaseURL.Path)
	databaseURL.Path = "/postgres"

	objects, err := blobstore.New(cluster.objects)
	require.NoError(t, err)

	snapshot := &deploymentSnapshot{
		cluster:  cluster,
		admin:    databaseURL.String(),
		database: database,
		template: database + "_snapshot",
		objects:  objects,
	}

	t.Cleanup(func() {
		snapshot.exec(t, context.WithoutCancel(t.Context()), "DROP DATABASE IF EXISTS "+pgx.Identifier{snapshot.template}.Sanitize()+" WITH (FORCE)")
	})

	return snapshot
}

func (snapshot *deploymentSnapshot) exec(t *testing.T, ctx context.Context, statements ...string) {
	t.Helper()

	conn, err := pgx.Connect(ctx, snapshot.admin)
	require.NoError(t, err)

	defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()

	for _, statement := range statements {
		_, err := conn.Exec(ctx, statement)
		require.NoError(t, err, statement)
	}
}

// take snapshots PostgreSQL first and S3 second, with the server stopped.
func (snapshot *deploymentSnapshot) take(t *testing.T) {
	t.Helper()

	snapshot.exec(t, t.Context(),
		"DROP DATABASE IF EXISTS "+pgx.Identifier{snapshot.template}.Sanitize(),
		"CREATE DATABASE "+pgx.Identifier{snapshot.template}.Sanitize()+" TEMPLATE "+pgx.Identifier{snapshot.database}.Sanitize(),
	)

	snapshot.saved = map[string][]byte{}
	for _, key := range snapshot.keys(t) {
		object, err := snapshot.objects.Client().GetObject(t.Context(), &s3.GetObjectInput{Bucket: aws.String(snapshot.cluster.objects.Bucket), Key: aws.String(key)})
		require.NoError(t, err)

		var body bytes.Buffer

		_, err = body.ReadFrom(object.Body)
		require.NoError(t, errors.Join(err, object.Body.Close()))

		snapshot.saved[key] = body.Bytes()
	}
}

// restore replaces the database and the bucket's objects with the
// snapshot's, with the server stopped.
func (snapshot *deploymentSnapshot) restore(t *testing.T) {
	t.Helper()
	require.NotNil(t, snapshot.saved, "restore before any snapshot")

	snapshot.exec(t, t.Context(),
		"DROP DATABASE "+pgx.Identifier{snapshot.database}.Sanitize()+" WITH (FORCE)",
		"CREATE DATABASE "+pgx.Identifier{snapshot.database}.Sanitize()+" TEMPLATE "+pgx.Identifier{snapshot.template}.Sanitize(),
	)

	bucket := aws.String(snapshot.cluster.objects.Bucket)

	for _, key := range snapshot.keys(t) {
		_, err := snapshot.objects.Client().DeleteObject(t.Context(), &s3.DeleteObjectInput{Bucket: bucket, Key: aws.String(key)})
		require.NoError(t, err)
	}

	for key, body := range snapshot.saved {
		_, err := snapshot.objects.Client().PutObject(t.Context(), &s3.PutObjectInput{Bucket: bucket, Key: aws.String(key), Body: bytes.NewReader(body)})
		require.NoError(t, err)
	}
}

func (snapshot *deploymentSnapshot) keys(t *testing.T) []string {
	t.Helper()

	var keys []string

	paginator := s3.NewListObjectsV2Paginator(snapshot.objects.Client(), &s3.ListObjectsV2Input{Bucket: aws.String(snapshot.cluster.objects.Bucket)})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(t.Context())
		require.NoError(t, err)

		for _, object := range page.Contents {
			keys = append(keys, aws.ToString(object.Key))
		}
	}

	return keys
}

// acceptanceSuite is a running plugin acceptance suite (vitest).
type acceptanceSuite struct {
	process *testinfra.Child
	output  *syncBuffer
	report  string
	exited  <-chan struct{}
}

// startAcceptanceSuite runs plugin/test/acceptance/<name>.acceptance.test.ts
// against the server at serverURL, with token and extra environment
// variables. Under `make acceptance` its vitest report is kept for the
// scoreboard.
func startAcceptanceSuite(t *testing.T, name, serverURL, token string, extra ...string) *acceptanceSuite {
	t.Helper()

	pluginDir, err := filepath.Abs(filepath.Join("..", "..", "plugin"))
	require.NoError(t, err)

	// The locally installed vitest, run directly: unlike `npx vitest`, this
	// can never fall back to fetching a package from the network.
	vitest := filepath.Join(pluginDir, "node_modules", ".bin", "vitest")
	_, err = os.Stat(vitest)
	require.NoError(t, err, "plugin dependencies are not installed; run `make test-integration`, which installs them")

	report := filepath.Join(t.TempDir(), "report.json")
	if results := os.Getenv(acceptanceResultsEnv); results != "" {
		report = filepath.Join(results, "vitest-acceptance-"+name+".json")
	}

	process := testinfra.NewChild(t, vitest, "run",
		"--config", "vitest.acceptance.config.ts",
		"--reporter", "default", "--reporter", "json", "--outputFile.json", report,
		"test/acceptance/"+name+".acceptance.test.ts",
	)
	process.Command.Dir = pluginDir

	process.Command.Env = append(append(os.Environ(),
		clientServerURLEnv+"="+serverURL,
		clientTokenEnv+"="+token,
		"CI=1", // no watch mode, no interactive output
	), extra...)

	output := &syncBuffer{}
	process.Command.Stdout = output
	process.Command.Stderr = output
	process.Start(t)

	return &acceptanceSuite{process: process, output: output, report: report, exited: process.Exited()}
}

// check fails the test if the suite failed or skipped its tests.
func (suite *acceptanceSuite) check(t *testing.T) {
	t.Helper()

	require.NoError(t, suite.process.Wait(), "plugin acceptance suite failed:\n%s", suite.output.String())
	t.Logf("plugin acceptance suite:\n%s", suite.output.String())

	// The suite skips itself when it is not configured; make sure it ran.
	var summary struct {
		NumTotalTests  int `json:"numTotalTests"`
		NumPassedTests int `json:"numPassedTests"`
	}

	raw, err := os.ReadFile(suite.report)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &summary))
	require.Positive(t, summary.NumTotalTests, "the plugin acceptance suite ran no tests")
	require.Equal(t, summary.NumTotalTests, summary.NumPassedTests, "every plugin acceptance test must run and pass, none skipped")
}
