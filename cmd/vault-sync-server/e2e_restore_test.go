//go:build e2e

package main_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/export"
)

// e2eRestoreControlURLEnv hands the restore spec (restore.e2e.ts) the URL of
// the driver's admin steps on the main server: the export job, and the
// restore of an exported vault into a new vault.
const e2eRestoreControlURLEnv = "VAULT_SYNC_E2E_RESTORE_CONTROL_URL"

// e2eImportSignInCode matches the line the import writes to stderr with the
// code that approves its sign-in.
var e2eImportSignInCode = regexp.MustCompile(`code (\S+)$`)

// e2eRestoreDeployment is the main server, as the admin's export job and
// restore command see it.
type e2eRestoreDeployment struct {
	binary   string
	database string
	bucket   blobstore.Config
	apiURL   string
	flow     *authtest.DeviceFlow
	// exports are the export directories the driver wrote, by the handle
	// the spec gets for each.
	exports map[string]string
}

// handle runs one admin step on the test goroutine.
func (deployment *e2eRestoreDeployment) handle(t *testing.T, request escrowControlRequest) escrowControlReply {
	t.Helper()

	var (
		result any
		err    error
	)

	switch request.action {
	case "export":
		result, err = deployment.export(t)
	case "restore":
		var options struct {
			Export      string `json:"export"`
			SourceVault string `json:"sourceVault"`
			TargetVault string `json:"targetVault"`
			Subject     string `json:"subject"`
		}

		if err = json.Unmarshal(request.body, &options); err == nil {
			result, err = deployment.restore(t, options.Export, options.SourceVault, options.TargetVault, options.Subject)
		}
	default:
		err = fmt.Errorf("unknown restore control action %q", request.action)
	}

	if err != nil {
		return escrowControlReply{err: err}
	}

	encoded, err := json.Marshal(result)

	return escrowControlReply{body: encoded, err: err}
}

// export runs the export job against the main server's database and bucket
// and returns a handle to its output directory. Other specs' end-to-end
// encrypted vaults have no escrow, so the job skips them and may exit 1:
// the caller checks the manifest of its own vault through the restore.
func (deployment *e2eRestoreDeployment) export(t *testing.T) (any, error) {
	t.Helper()

	output := filepath.Join(t.TempDir(), "export")

	var stdout, stderr bytes.Buffer

	command := exec.CommandContext(t.Context(), deployment.binary, "export", "-out", output)
	command.Env = append(withoutServerSettings(os.Environ()), config.DatabaseURLEnv+"="+deployment.database, config.LogLevelEnv+"=warn")
	command.Env = append(command.Env, bucketEnvironment(deployment.bucket)...)
	command.Stdout = &stdout
	command.Stderr = &stderr

	code := 0

	var exitErr *exec.ExitError

	if err := command.Run(); errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
	} else if err != nil {
		return nil, fmt.Errorf("export: %w: %s", err, stderr.String())
	}

	t.Logf("export logs:\n%s", stderr.String())

	if _, err := os.Lstat(filepath.Join(output, export.MarkerName)); err != nil {
		return nil, fmt.Errorf("export exited %d and wrote no export: %w; summary: %s; logs: %s", code, err, stdout.String(), stderr.String())
	}

	handle := strconv.Itoa(len(deployment.exports) + 1)
	deployment.exports[handle] = output

	return map[string]any{"export": handle, "code": code}, nil
}

// restoreResult is a run of `import -from-export`: its exit code and its
// JSON report.
type restoreResult struct {
	Code   int             `json:"code"`
	Report json.RawMessage `json:"report"`
}

// restore runs `vault-sync-server import -from-export` of sourceVault in the
// export with the given handle into targetVault, signed in as subject, as
// the admin does.
func (deployment *e2eRestoreDeployment) restore(t *testing.T, handle, sourceVault, targetVault, subject string) (any, error) {
	t.Helper()

	directory, found := deployment.exports[handle]
	if !found {
		return nil, fmt.Errorf("no export %q", handle)
	}

	for _, id := range []string{sourceVault, targetVault} {
		if _, err := uuid.Parse(id); err != nil {
			return nil, fmt.Errorf("%q is not a vault id", id)
		}
	}

	if subject == "" {
		return nil, errors.New("the restore needs the subject that signs it in")
	}

	var stdout bytes.Buffer

	command := exec.CommandContext(t.Context(), deployment.binary,
		"import", "-from-export", directory, "-source-vault", sourceVault, deployment.apiURL, targetVault)
	command.Env = withoutServerSettings(os.Environ())
	command.Stdout = &stdout

	stderr, err := command.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := command.Start(); err != nil {
		return nil, err
	}

	var logs strings.Builder

	scanner := bufio.NewScanner(stderr)
	for scanner.Scan() {
		line := scanner.Text()
		logs.WriteString(line + "\n")

		if match := e2eImportSignInCode.FindStringSubmatch(line); match != nil && !deployment.flow.ApproveAs(match[1], subject) {
			logs.WriteString("(the driver found no sign-in to approve for this code)\n")
		}
	}

	code := 0

	var exitErr *exec.ExitError

	if err := command.Wait(); errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
	} else if err != nil {
		return nil, fmt.Errorf("import: %w: %s", err, logs.String())
	}

	t.Logf("restore logs:\n%s", logs.String())

	report := json.RawMessage(bytes.TrimSpace(stdout.Bytes()))
	if !json.Valid(report) {
		return nil, fmt.Errorf("the restore exited %d and printed no JSON report: %q; logs: %s", code, stdout.String(), logs.String())
	}

	return restoreResult{Code: code, Report: report}, nil
}
