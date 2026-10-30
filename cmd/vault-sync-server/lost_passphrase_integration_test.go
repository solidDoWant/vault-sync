//go:build integration && linux

package main_test

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

// exportVaults runs `vault-sync-server export -out output` against the
// deployment, as the operator's export job, with the escrow identities in
// identityFile, and returns its exit code and summary.
func (cluster *deployment) exportVaults(t *testing.T, binary, identityFile, output string) (int, export.Summary) {
	t.Helper()

	var stdout, stderr bytes.Buffer

	command := exec.CommandContext(t.Context(), binary, "export", "-out", output)

	command.Env = append(os.Environ(),
		config.DatabaseURLEnv+"="+cluster.database.DSN,
		config.S3EndpointEnv+"="+cluster.objects.Endpoint,
		config.S3RegionEnv+"="+cluster.objects.Region,
		config.S3BucketEnv+"="+cluster.objects.Bucket,
		config.S3AccessKeyIDFileEnv+"="+cluster.objects.AccessKeyIDFile,
		config.S3SecretAccessKeyFileEnv+"="+cluster.objects.SecretAccessKeyFile,
		config.S3ForcePathStyleEnv+"="+strconv.FormatBool(cluster.objects.ForcePathStyle),
		config.EscrowIdentityFileEnv+"="+identityFile,
	)
	command.Stdout = &stdout
	command.Stderr = &stderr

	code := 0

	var exitErr *exec.ExitError

	if err := command.Run(); errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
	} else {
		require.NoError(t, err, "export: %s", stderr.String())
	}

	t.Logf("export logs:\n%s", stderr.String())

	var summary export.Summary
	require.NoError(t, json.Unmarshal(stdout.Bytes(), &summary), "export summary: %s", stdout.String())

	return code, summary
}

// exportedFiles returns the regular files under directory, by slash path,
// with their content.
func exportedFiles(t *testing.T, directory string) map[string]string {
	t.Helper()

	files := map[string]string{}

	require.NoError(t, filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
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
	}))

	return files
}

// A user who loses the recovery passphrase, with one vault escrowed and one
// not, followed by the documented recovery (docs/encryption.md, "Losing your
// passphrase"): the export job writes the escrowed vault in plaintext, and the
// operator imports that copy into a new encrypted vault of the user's new key
// through the escrow identity. Afterwards the deployment's database, bucket and
// logs are searched for anything that must never reach the server.
func TestLostPassphraseAndEscrowRecovery(t *testing.T) {
	cluster := newDeployment(t)
	flow := cluster.issuer.EnableDeviceFlow(t, cluster.key, authtest.DeviceFlowOptions{})
	binary := buildServer(t)
	escrow := newEscrowKey(t)
	server := cluster.start(t, "server", binary,
		append([]string{config.OIDCClientIDEnv + "=" + authtest.DefaultAudience}, escrow.environment()...)...)
	alice := newEncryptedMember(t, server, cluster.token(t, "alice"))

	// Distinctive names and contents, so any plaintext copy is found.
	marker := strings.ToLower(rand.Text())
	files := map[string]string{
		"Diary " + marker + ".md":                           "# Lost diary " + marker + "\n\nOnly escrow can bring this back.\n",
		"Taxes " + marker + "/return " + marker + ".md":     "- refund owed " + marker + "\n",
		"Attachments/receipt " + marker + ".pdf":            "%PDF-1.7 receipt body " + marker + "\n",
		"Attachments/archive " + marker + ".bin":            string(bytes.Repeat([]byte("archived "+marker+" "), 200_000)),
		"Taxes " + marker + "/blank form " + marker + ".md": "",
	}

	source := t.TempDir()

	for name, content := range files {
		full := filepath.Join(source, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
		require.NoError(t, os.WriteFile(full, []byte(content), 0o600))
	}

	expected := map[string]syncedFile{}
	plaintexts := []string{marker, "Lost diary", "refund owed", "receipt body", "archived"}

	for name, content := range files {
		kind := vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB
		if strings.HasSuffix(name, ".md") {
			kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT
		}

		expected[name] = syncedFile{Kind: kind, Digest: digest(content)}
		plaintexts = append(plaintexts, name)
	}

	secrets := t.TempDir()
	passphraseFile := filepath.Join(secrets, "passphrase")
	require.NoError(t, os.WriteFile(passphraseFile, []byte(alice.passphrase+"\n"), 0o600))

	identityFile := filepath.Join(secrets, "escrow-identity.txt")
	require.NoError(t, os.WriteFile(identityFile, []byte("# public key: "+escrow.recipient+"\n"+escrow.identity+"\n"), 0o600))

	// Alice's devices fill both vaults while she still knows the passphrase.
	escrowed := createEscrowedVault(t, server, alice, escrow, "Escrowed", 2)
	escrowedKeys := alice.epochKeys

	code, report, importLogs := cluster.importFolderWithLogs(t, binary, server, flow, "alice", escrowed.GetId(), source, "-passphrase-file", passphraseFile)
	require.Equal(t, vaultimport.StatusOK, report.Status, report.Error)
	require.Equal(t, 0, code)

	private := createEncryptedVault(t, server, alice, "Members only", 1)

	code, report, logs := cluster.importFolderWithLogs(t, binary, server, flow, "alice", private.GetId(), source, "-passphrase-file", passphraseFile)
	importLogs += logs

	require.Equal(t, vaultimport.StatusOK, report.Status, report.Error)
	require.Equal(t, 0, code)

	var renewed *encryptedMember

	t.Run("[P4-14] a lost passphrase leaves the server's copy unreadable without escrow, and the documented escrow recovery restores an escrowed vault", func(t *testing.T) {
		// Alice forgot the passphrase: what she remembers unlocks no key,
		// so no tool of hers can read or write a vault (the import needs an
		// empty one).
		empty := createEncryptedVault(t, server, alice, "Empty", 1)
		forgotten := filepath.Join(secrets, "forgotten")
		require.NoError(t, os.WriteFile(forgotten, []byte("something like my old passphrase\n"), 0o600))

		code, report, logs := cluster.importFolderWithLogs(t, binary, server, flow, "alice", empty.GetId(), source, "-passphrase-file", forgotten)
		importLogs += logs

		assert.Equal(t, 1, code)
		assert.Equal(t, vaultimport.StatusFailed, report.Status)
		assert.Contains(t, report.Error, "passphrase is wrong")
		assert.Empty(t, alice.decryptAll(t, server, empty.GetId()))

		// The operator's export job decrypts the escrowed vault, and skips and reports the other.
		output := filepath.Join(t.TempDir(), "export")
		code, summary := cluster.exportVaults(t, binary, identityFile, output)

		assert.Equal(t, 0, code, summary.Error)
		assert.Equal(t, export.StatusOK, summary.Status, summary.Error)
		assert.Equal(t, 1, summary.Vaults)
		assert.Equal(t, 2, summary.SkippedVaults)

		details := map[uuid.UUID]export.VaultSummary{}
		for _, vault := range summary.VaultDetails {
			details[vault.ID] = vault
		}

		for _, vault := range []*vaultsyncv1.Vault{private, empty} {
			assert.Equal(t, export.SkippedNoEscrow, details[uuid.MustParse(vault.GetId())].Skipped, vault.GetName())
			assert.NoDirExists(t, filepath.Join(output, vault.GetId()))
		}

		recovered := filepath.Join(output, escrowed.GetId())
		require.Equal(t, files, exportedFiles(t, recovered), "the export holds the escrowed vault in plaintext")

		// Alice gets a new key, and the operator imports her copy into a new escrowed vault through the escrow identity.
		renewed = newEncryptedMember(t, server, cluster.token(t, "alice-again"))
		restored := createEscrowedVault(t, server, renewed, escrow, "Restored", 1)

		code, report, logs = cluster.importFolderWithLogs(t, binary, server, flow, "alice-again", restored.GetId(), recovered,
			"-escrow-identity-file", identityFile, "-genesis", renewed.genesis(restored.GetId()))
		importLogs += logs

		require.Equal(t, vaultimport.StatusOK, report.Status, report.Error)
		assert.Equal(t, 0, code)

		// Her new device reads the restored vault.
		assert.Equal(t, expected, renewed.decryptAll(t, server, restored.GetId()))

		// The escrowed original still decrypts unchanged with the vault's keys.
		alice.epochKeys = escrowedKeys
		assert.Equal(t, expected, alice.decryptAll(t, server, escrowed.GetId()))
	})

	t.Run("[P4-16] the database, S3 and the logs hold no plaintext content, path, passphrase, private key or vault key", func(t *testing.T) {
		needles := alice.secretNeedles(t, plaintexts...)
		keyNeedles := alice.secretNeedles(t)

		// The new key of the recovery, when it got that far.
		if renewed != nil {
			for name, needle := range renewed.secretNeedles(t) {
				needles["new "+name] = needle
				keyNeedles["new "+name] = needle
			}
		}

		escrowNeedles := map[string][]byte{
			"escrow private key":           escrow.privateKey,
			"escrow identity":              []byte(escrow.identity),
			"escrow identity (lower case)": []byte(strings.ToLower(escrow.identity)),
		}
		for name, needle := range escrowNeedles {
			needles[name] = needle
		}

		assertNoSecrets(t, "the database", cluster.databaseText(t), needles)
		assertNoSecrets(t, "S3", cluster.objectsContent(t), needles)
		assertNoSecrets(t, "the server's logs", []byte(server.logs.String()), needles)

		// The import's own logs stay on the operator's machine, but never
		// carry a passphrase or a key either.
		for name, needle := range escrowNeedles {
			keyNeedles[name] = needle
		}

		assertNoSecrets(t, "the import's logs", []byte(importLogs), keyNeedles)
	})
}
