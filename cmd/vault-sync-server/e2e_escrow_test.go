//go:build e2e

package main_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// Environment variables through which the driver hands the escrow server and
// its operator controls to the escrow reset spec (escrow-reset.e2e.ts).
const (
	e2eEscrowServerURLEnv  = "VAULT_SYNC_E2E_ESCROW_SERVER_URL"
	e2eEscrowControlURLEnv = "VAULT_SYNC_E2E_ESCROW_CONTROL_URL"
)

// e2eEscrowKey is one escrow key pair of the escrow server: the age key and
// the signing key of its bundle.
type e2eEscrowKey struct {
	identity string
	bundle   e2ee.EscrowBundle
	signing  ed25519.PrivateKey
}

func newE2EEscrowKey(t *testing.T) e2eEscrowKey {
	t.Helper()

	privateKey, publicKey, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	identity, err := e2ee.AgeIdentity(privateKey)
	require.NoError(t, err)

	recipient, err := e2ee.AgeRecipient(publicKey)
	require.NoError(t, err)

	signPub, signing, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	return e2eEscrowKey{identity: identity, bundle: e2ee.EscrowBundle{SignPub: signPub, Recipient: recipient}, signing: signing}
}

// serverEnvironment is the server's configuration of this key as its escrow
// bundle.
func (key e2eEscrowKey) serverEnvironment() []string {
	return []string{
		config.EscrowRecipientEnv + "=" + key.bundle.Recipient,
		config.EscrowSigningKeyEnv + "=" + base64.StdEncoding.EncodeToString(key.bundle.SignPub),
	}
}

// bundleFlags are the -recipient and -signing-public-key flags of
// `export rotate-escrow` and `export reset-escrow` for this key.
func (key e2eEscrowKey) bundleFlags() []string {
	return []string{"-recipient", key.bundle.Recipient, "-signing-public-key", base64.StdEncoding.EncodeToString(key.bundle.SignPub)}
}

// fingerprint is the escrow fingerprint the admin publishes for this key.
func (key e2eEscrowKey) fingerprint() (string, error) {
	fingerprint, err := key.bundle.Fingerprint()
	if err != nil {
		return "", err
	}

	return e2ee.FormatFingerprint(fingerprint), nil
}

// e2eEscrowDeployment is a second server, with escrow, for the escrow reset
// spec. It has its own database and bucket, so its escrow chain is its own
// and no other spec sees its escrow key. The plugin reaches it through a
// loopback proxy, so the server can restart on a new escrow bundle at the
// same URL, as an admin's deployment does.
type e2eEscrowDeployment struct {
	binary    string
	baseEnv   []string
	database  string
	bucket    blobstore.Config
	secrets   string
	jobToken  string
	current   atomic.Pointer[url.URL]
	directURL string
	stop      func()
	old, new  *e2eEscrowKey
	proxyURL  string
}

// startE2EEscrowDeployment starts the escrow server with escrow key old and
// the proxy in front of it.
func startE2EEscrowDeployment(t *testing.T, binary string, baseEnv []string) *e2eEscrowDeployment {
	t.Helper()

	database := testinfra.PostgresConfig(t)
	bucket := testinfra.S3Bucket(t)
	secrets := t.TempDir()
	jobToken := filepath.Join(secrets, "job.token")
	require.NoError(t, os.WriteFile(jobToken, []byte(rand.Text()+rand.Text()+"\n"), 0o600))

	old := newE2EEscrowKey(t)
	deployment := &e2eEscrowDeployment{binary: binary, baseEnv: baseEnv, database: database.DSN, bucket: bucket, secrets: secrets, jobToken: jobToken, old: &old}
	deployment.start(t, old)

	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(deployment.current.Load())
		},
		// Streams the realtime channel's frames as they come.
		FlushInterval: -1,
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	server := &http.Server{Handler: proxy, ReadHeaderTimeout: readHeaderTimeout}

	go func() { _ = server.Serve(listener) }()

	t.Cleanup(func() { _ = server.Close() })

	deployment.proxyURL = "http://" + listener.Addr().String()

	return deployment
}

// readHeaderTimeout bounds the header reads of the driver's own loopback
// servers.
const readHeaderTimeout = 10 * time.Second

// start starts a server with key as its escrow bundle, points the proxy at
// it and stops the previous one.
func (deployment *e2eEscrowDeployment) start(t *testing.T, key e2eEscrowKey) {
	t.Helper()

	env := append([]string{}, deployment.baseEnv...)
	env = append(env, config.DatabaseURLEnv+"="+deployment.database, config.EscrowJobTokenFileEnv+"="+deployment.jobToken)
	env = append(env, bucketEnvironment(deployment.bucket)...)
	env = append(env, key.serverEnvironment()...)

	apiAddress, stop := startE2EServer(t, "escrow server", deployment.binary, env)

	target, err := url.Parse("http://" + apiAddress)
	require.NoError(t, err)

	deployment.current.Store(target)
	deployment.directURL = target.String()

	if deployment.stop != nil {
		deployment.stop()
	}

	deployment.stop = stop
}

// bucketEnvironment is the object store configuration of bucket.
func bucketEnvironment(bucket blobstore.Config) []string {
	return []string{
		config.S3EndpointEnv + "=" + bucket.Endpoint,
		config.S3RegionEnv + "=" + bucket.Region,
		config.S3BucketEnv + "=" + bucket.Bucket,
		config.S3AccessKeyIDFileEnv + "=" + bucket.AccessKeyIDFile,
		config.S3SecretAccessKeyFileEnv + "=" + bucket.SecretAccessKeyFile,
		config.S3ForcePathStyleEnv + "=true",
	}
}

// escrowControlRequest is one operator step the escrow reset spec asks for.
type escrowControlRequest struct {
	action string
	body   []byte
	reply  chan escrowControlReply
}

type escrowControlReply struct {
	body []byte
	err  error
}

// serveEscrowControl serves the operator steps at a loopback URL. Each
// request is handed to requests, so the test goroutine runs it, and its
// reply is sent back.
func serveEscrowControl(t *testing.T, requests chan<- escrowControlRequest) string {
	t.Helper()

	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := readBounded(request)
		if err != nil || request.Method != http.MethodPost {
			http.Error(writer, "POST a JSON body of at most 64 KiB", http.StatusBadRequest)

			return
		}

		control := escrowControlRequest{action: strings.TrimPrefix(request.URL.Path, "/"), body: body, reply: make(chan escrowControlReply, 1)}

		select {
		case requests <- control:
		case <-request.Context().Done():
			return
		}

		select {
		case reply := <-control.reply:
			if reply.err != nil {
				http.Error(writer, reply.err.Error(), http.StatusInternalServerError)

				return
			}

			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write(reply.body)
		case <-request.Context().Done():
		}
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	server := &http.Server{Handler: handler, ReadHeaderTimeout: readHeaderTimeout}

	go func() { _ = server.Serve(listener) }()

	// Close, unlike Shutdown, does not wait for a handler whose request the
	// test goroutine no longer answers.
	t.Cleanup(func() { _ = server.Close() })

	return "http://" + listener.Addr().String()
}

func readBounded(request *http.Request) ([]byte, error) {
	var buffer bytes.Buffer

	if _, err := buffer.ReadFrom(http.MaxBytesReader(nil, request.Body, 64<<10)); err != nil {
		return nil, err
	}

	return buffer.Bytes(), nil
}

// handle runs one operator step on the test goroutine.
func (deployment *e2eEscrowDeployment) handle(t *testing.T, request escrowControlRequest) escrowControlReply {
	t.Helper()

	var (
		result any
		err    error
	)

	switch request.action {
	case "reset":
		result, err = deployment.reset(t)
	case "rotate":
		result, err = deployment.rotate(t)
	case "export":
		var options struct {
			Identities []string `json:"identities"`
		}

		if err = json.Unmarshal(request.body, &options); err == nil {
			result, err = deployment.export(t, options.Identities)
		}
	default:
		err = fmt.Errorf("unknown escrow control action %q", request.action)
	}

	if err != nil {
		return escrowControlReply{err: err}
	}

	encoded, err := json.Marshal(result)

	return escrowControlReply{body: encoded, err: err}
}

// commandResult is a run of a `vault-sync-server export …` command: its exit
// code and its one-line JSON summary.
type commandResult struct {
	Code    int             `json:"code"`
	Summary json.RawMessage `json:"summary"`
}

// run runs the server binary with args and the escrow deployment's database
// plus env, as the admin's job does.
func (deployment *e2eEscrowDeployment) run(t *testing.T, env []string, args ...string) (commandResult, error) {
	t.Helper()

	var stdout, stderr bytes.Buffer

	command := exec.CommandContext(t.Context(), deployment.binary, args...)
	command.Env = append(withoutServerSettings(os.Environ()), config.DatabaseURLEnv+"="+deployment.database, config.LogLevelEnv+"=warn")
	command.Env = append(command.Env, env...)
	command.Stdout = &stdout
	command.Stderr = &stderr

	result := commandResult{}

	var exitErr *exec.ExitError

	if err := command.Run(); errors.As(err, &exitErr) {
		result.Code = exitErr.ExitCode()
	} else if err != nil {
		return result, fmt.Errorf("%s: %w: %s", args[0], err, stderr.String())
	}

	t.Logf("%s logs:\n%s", strings.Join(args[:min(2, len(args))], " "), stderr.String())

	result.Summary = json.RawMessage(bytes.TrimSpace(stdout.Bytes()))
	if !json.Valid(result.Summary) {
		return result, fmt.Errorf("%s printed no JSON summary: %q; logs: %s", args[0], stdout.String(), stderr.String())
	}

	return result, nil
}

// reset is the admin's escrow reset after the signing key of the chain's
// head was lost: a new key pair, `export reset-escrow` to it, and the server
// restarted on it. The old signing key is never used again. It returns the
// old and the new fingerprint, as the admin publishes them.
func (deployment *e2eEscrowDeployment) reset(t *testing.T) (any, error) {
	t.Helper()

	if deployment.new != nil {
		return nil, errors.New("the escrow server was already reset")
	}

	key := newE2EEscrowKey(t)

	result, err := deployment.run(t, []string{config.EscrowJobTokenFileEnv + "=" + deployment.jobToken},
		append([]string{"export", "reset-escrow", "-server", deployment.directURL}, key.bundleFlags()...)...)
	if err != nil {
		return nil, err
	}

	if result.Code != 0 {
		return nil, fmt.Errorf("export reset-escrow exited %d: %s", result.Code, result.Summary)
	}

	deployment.new = &key
	deployment.start(t, key)

	previous, err := deployment.old.fingerprint()
	if err != nil {
		return nil, err
	}

	current, err := key.fingerprint()
	if err != nil {
		return nil, err
	}

	return map[string]string{"previous": previous, "current": current}, nil
}

// rotate runs `export rotate-escrow` to the new key with both identities and
// the new key's signing key alone, as the admin does after a reset to move
// the adopted vaults' old escrow slots to the new key.
func (deployment *e2eEscrowDeployment) rotate(t *testing.T) (any, error) {
	t.Helper()

	if deployment.new == nil {
		return nil, errors.New("the escrow server was not reset")
	}

	identities, err := deployment.identityFile("old", "new")
	if err != nil {
		return nil, err
	}

	signingKeys := filepath.Join(deployment.secrets, "signing.keys")
	if err := os.WriteFile(signingKeys, []byte(base64.StdEncoding.EncodeToString(deployment.new.signing.Seed())+"\n"), 0o600); err != nil {
		return nil, err
	}

	return deployment.run(t,
		[]string{
			config.EscrowJobTokenFileEnv + "=" + deployment.jobToken,
			config.EscrowIdentityFileEnv + "=" + identities,
			config.EscrowSigningKeyFileEnv + "=" + signingKeys,
		},
		append([]string{"export", "rotate-escrow", "-server", deployment.directURL}, deployment.new.bundleFlags()...)...)
}

// exportResult is an export run and the files it wrote, by vault id and
// slash path.
type exportResult struct {
	commandResult

	Files map[string]map[string]string `json:"files"`
}

// export runs the export job with the named escrow identities ("old",
// "new") in its identity file.
func (deployment *e2eEscrowDeployment) export(t *testing.T, names []string) (any, error) {
	t.Helper()

	identities, err := deployment.identityFile(names...)
	if err != nil {
		return nil, err
	}

	output := filepath.Join(t.TempDir(), "export")

	env := append(bucketEnvironment(deployment.bucket), config.EscrowIdentityFileEnv+"="+identities)

	result, err := deployment.run(t, env, "export", "-out", output)
	if err != nil {
		return nil, err
	}

	files := map[string]map[string]string{}

	entries, err := os.ReadDir(output)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		vault, err := readTree(filepath.Join(output, entry.Name()))
		if err != nil {
			return nil, err
		}

		files[entry.Name()] = vault
	}

	return exportResult{commandResult: result, Files: files}, nil
}

// identityFile writes the named escrow identities to a new identity file.
func (deployment *e2eEscrowDeployment) identityFile(names ...string) (string, error) {
	lines := []string{}

	for _, name := range names {
		key := map[string]*e2eEscrowKey{"old": deployment.old, "new": deployment.new}[name]
		if key == nil {
			return "", fmt.Errorf("no %q escrow identity", name)
		}

		lines = append(lines, "# "+name, key.identity)
	}

	file, err := os.CreateTemp(deployment.secrets, "escrow-*.key")
	if err != nil {
		return "", err
	}

	defer func() { _ = file.Close() }()

	if _, err := file.WriteString(strings.Join(lines, "\n") + "\n"); err != nil {
		return "", err
	}

	return file.Name(), nil
}

// readTree returns the regular files under directory, by slash path, with
// their content.
func readTree(directory string) (map[string]string, error) {
	files := map[string]string{}

	err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() {
			return err
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		relative, err := filepath.Rel(directory, path)
		if err != nil {
			return err
		}

		files[filepath.ToSlash(relative)] = string(content)

		return nil
	})

	return files, err
}
