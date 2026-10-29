//go:build integration

package main_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/e2ee/logtest"
	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

// escrowKey is a deployment's escrow key pair.
type escrowKey struct {
	privateKey []byte
	publicKey  []byte
	keyID      string
	identity   string
	recipient  string
}

func newEscrowKey(t *testing.T) escrowKey {
	t.Helper()

	privateKey, publicKey, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	key := escrowKey{privateKey: privateKey, publicKey: publicKey}

	key.keyID, err = e2ee.EscrowKeyID(publicKey)
	require.NoError(t, err)

	key.identity, err = e2ee.AgeIdentity(privateKey)
	require.NoError(t, err)

	key.recipient, err = e2ee.AgeRecipient(publicKey)
	require.NoError(t, err)

	return key
}

// createEscrowedVault creates an end-to-end encrypted vault with escrow
// owned by member and gives it epochs 1 to epochs, each wrapped to member
// and to the escrow key, as the owner's plugin device does.
func createEscrowedVault(t *testing.T, server *instance, member *encryptedMember, escrow escrowKey, name string, epochs uint64) *vaultsyncv1.Vault {
	t.Helper()

	// The genesis entry names its creator and records the escrow key, so
	// the user id comes first: the user key's row names it.
	connection, err := pgx.Connect(t.Context(), server.databaseDSN)
	require.NoError(t, err)

	var userID uuid.UUID

	err = connection.QueryRow(t.Context(), `SELECT user_id FROM user_keys WHERE public_key = $1`, member.publicKey).Scan(&userID)
	require.NoError(t, connection.Close(t.Context()))
	require.NoError(t, err)

	escrowSignPub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	vaultID := uuid.Must(uuid.NewV7())
	log := logtest.New(t, vaultID, userID, &e2ee.EscrowBundle{SignPub: escrowSignPub, Recipient: escrow.recipient})

	response, err := server.vaults().CreateVault(t.Context(), authorized(&vaultsyncv1.CreateVaultRequest{
		Name: name, Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE, Escrow: true,
		NewVaultId: vaultID.String(), Genesis: logtest.EntryMessage(log.Entries[0]),
	}, member.token))
	require.NoError(t, err)

	vault := response.Msg.GetVault()
	require.True(t, vault.GetEscrow())

	member.userID = userID.String()
	member.epochKeys = map[uint64][]byte{}

	keys := vaultsyncv1connect.NewVaultKeyServiceClient(httpClient, server.apiURL)

	var previous []byte

	for epoch := uint64(1); epoch <= epochs; epoch++ {
		epochKey, err := e2ee.GenerateKey()
		require.NoError(t, err)

		commitment, err := e2ee.KeyCommitment(epochKey, vault.GetId(), epoch)
		require.NoError(t, err)

		userSlot, err := e2ee.SealKeySlot(member.publicKey, epochKey, e2ee.KeySlot{
			VaultID: vault.GetId(), Epoch: epoch, RecipientKind: e2ee.RecipientUser, RecipientID: member.userID,
		})
		require.NoError(t, err)

		escrowSlot, err := e2ee.SealKeySlot(escrow.publicKey, epochKey, e2ee.KeySlot{
			VaultID: vault.GetId(), Epoch: epoch, RecipientKind: e2ee.RecipientEscrow, RecipientID: escrow.keyID,
		})
		require.NoError(t, err)

		record := log.Record(t, userID, epoch, commitment, previous)
		previous = commitment

		_, err = keys.RotateEpoch(t.Context(), authorized(&vaultsyncv1.RotateEpochRequest{
			Record:  logtest.RecordMessage(record),
			VaultId: vault.GetId(),
			NextEpoch: &vaultsyncv1.NextEpoch{
				ExpectedEpoch: uint32(epoch - 1),
				Commitment:    commitment,
				Slots: []*vaultsyncv1.KeySlot{
					{RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER, RecipientId: member.userID, WrappedKey: userSlot},
					{RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW, RecipientId: escrow.keyID, WrappedKey: escrowSlot},
				},
			},
		}, member.token))
		require.NoError(t, err, "rotate to epoch %d", epoch)

		member.epochKeys[epoch] = epochKey
		member.allEpochKeys = append(member.allEpochKeys, epochKey)
	}

	return vault
}

func TestImportIntoAnEscrowedVault(t *testing.T) {
	cluster := newDeployment(t)
	flow := cluster.issuer.EnableDeviceFlow(t, cluster.key, authtest.DeviceFlowOptions{})
	binary := buildServer(t)
	escrow := newEscrowKey(t)
	server := cluster.start(t, "server", binary,
		config.OIDCClientIDEnv+"="+authtest.DefaultAudience, config.EscrowRecipientEnv+"="+escrow.recipient)
	member := newEncryptedMember(t, server, cluster.token(t, "alice"))

	// Distinctive names and contents, so any plaintext copy is found.
	marker := strings.ToLower(rand.Text())
	files := map[string]string{
		"Escrow journal " + marker + ".md":                  "# Escrowed journal " + marker + "\n\nNothing here may reach the server.\n",
		"Notes " + marker + "/plan " + marker + ".md":       "- [ ] secret milestone " + marker + "\n",
		"Attachments/photo " + marker + ".png":              "\x89PNG private " + marker + "\n",
		"Attachments/large " + marker + ".bin":              string(bytes.Repeat([]byte("escrowed "+marker+" "), 300_000)),
		"Notes " + marker + "/empty note " + marker + ".md": "",
	}

	source := t.TempDir()

	for name, content := range files {
		full := filepath.Join(source, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
		require.NoError(t, os.WriteFile(full, []byte(content), 0o600))
	}

	emptyFolder := "Inbox " + marker
	require.NoError(t, os.MkdirAll(filepath.Join(source, emptyFolder), 0o755))

	expected := map[string]syncedFile{emptyFolder: {Kind: vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER}}
	plaintexts := []string{marker, emptyFolder, "Escrowed journal", "secret milestone", "PNG private"}

	for name, content := range files {
		kind := vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB
		if strings.HasSuffix(name, ".md") {
			kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT
		}

		expected[name] = syncedFile{Kind: kind, Digest: digest(content)}
		plaintexts = append(plaintexts, name)
	}

	// The identity file as age-keygen writes it, with a retiring identity
	// that opens nothing in this vault.
	retiring := newEscrowKey(t)
	identityFile := filepath.Join(t.TempDir(), "escrow-identity.txt")
	require.NoError(t, os.WriteFile(identityFile, []byte("# created: today\n# public key: "+escrow.recipient+"\n"+escrow.identity+"\n"+retiring.identity+"\n"), 0o600))

	importLogs := ""

	t.Run("P4-13 a device decrypts every file imported with the escrow identity", func(t *testing.T) {
		// Two epochs: content and paths are sealed under the current one,
		// path keys under epoch 1's path_key_secret.
		vault := createEscrowedVault(t, server, member, escrow, "Escrowed", 2)

		code, report, logs := cluster.importFolderWithLogs(t, binary, server, flow, "alice", vault.GetId(), source, "-escrow-identity-file", identityFile)
		importLogs += logs

		require.Equal(t, vaultimport.StatusOK, report.Status, report.Error)
		assert.Equal(t, 0, code)
		assert.Equal(t, vaultimport.Counts{Text: 3, Blob: 2, Folder: 1}, report.Imported)

		assert.Equal(t, expected, member.decryptAll(t, server, vault.GetId()))
	})

	t.Run("an identity that opens no escrow slot imports nothing", func(t *testing.T) {
		vault := createEscrowedVault(t, server, member, escrow, "Wrong identity", 1)

		wrongFile := filepath.Join(t.TempDir(), "wrong-identity.txt")
		require.NoError(t, os.WriteFile(wrongFile, []byte(retiring.identity+"\n"), 0o600))

		code, report, logs := cluster.importFolderWithLogs(t, binary, server, flow, "alice", vault.GetId(), source, "-escrow-identity-file", wrongFile)
		importLogs += logs

		assert.Equal(t, 1, code)
		assert.Equal(t, vaultimport.StatusFailed, report.Status)
		assert.Contains(t, report.Error, "escrow identity file does not hold")
		assert.Empty(t, member.decryptAll(t, server, vault.GetId()))
	})

	t.Run("the database, S3 and the logs hold no plaintext content, path or key", func(t *testing.T) {
		needles := member.secretNeedles(t, plaintexts...)
		escrowNeedles := map[string][]byte{
			"escrow private key":                    escrow.privateKey,
			"escrow identity":                       []byte(escrow.identity),
			"escrow identity (lower case)":          []byte(strings.ToLower(escrow.identity)),
			"retiring escrow private key":           retiring.privateKey,
			"retiring escrow identity":              []byte(retiring.identity),
			"retiring escrow identity (lower case)": []byte(strings.ToLower(retiring.identity)),
		}

		for name, needle := range escrowNeedles {
			needles[name] = needle
		}

		assertNoSecrets(t, "the database", cluster.databaseText(t), needles)
		assertNoSecrets(t, "S3", cluster.objectsContent(t), needles)
		assertNoSecrets(t, "the server's logs", []byte(server.logs.String()), needles)

		// The import's own logs stay on the operator's machine, but never
		// carry the escrow identity or a key either.
		keyNeedles := member.secretNeedles(t)
		for name, needle := range escrowNeedles {
			keyNeedles[name] = needle
		}

		assertNoSecrets(t, "the import's logs", []byte(importLogs), keyNeedles)
	})
}
