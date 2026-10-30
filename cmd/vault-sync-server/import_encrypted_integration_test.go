//go:build integration

package main_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/e2ee/logtest"
	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

// encryptedMember is a member of an end-to-end encrypted vault as a plugin
// device sets it up: a user key wrapped under the recovery passphrase, and
// the vault's epoch keys.
type encryptedMember struct {
	token      string
	userID     string
	passphrase string
	privateKey []byte
	publicKey  []byte
	// epochKeys are the epoch keys of the last vault created, by epoch.
	epochKeys map[uint64][]byte
	// allEpochKeys are the epoch keys of every vault created.
	allEpochKeys [][]byte
	// anchors are the genesis hashes of every vault created, in the
	// member's sealed anchor list at anchorVersion.
	anchors       []e2ee.Anchor
	anchorVersion uint64
}

// anchorVault adds the vault whose log is log to the member's anchor list
// and stores the list, as the creator's plugin device does.
func (member *encryptedMember) anchorVault(t *testing.T, server *instance, log *logtest.Log) {
	t.Helper()

	genesisHash, err := log.Entries[0].Hash()
	require.NoError(t, err)

	anchorKey, err := e2ee.AnchorKey(member.privateKey)
	require.NoError(t, err)

	member.anchors = append(member.anchors, e2ee.Anchor{VaultID: log.VaultID, GenesisHash: genesisHash})
	member.anchorVersion++

	sealed, err := e2ee.SealAnchorList(anchorKey, member.userID, member.anchorVersion, member.anchors)
	require.NoError(t, err)

	_, err = vaultsyncv1connect.NewUserKeyServiceClient(httpClient, server.apiURL).PutAnchorList(t.Context(), authorized(&vaultsyncv1.PutAnchorListRequest{
		Version: member.anchorVersion, SealedList: sealed,
	}, member.token))
	require.NoError(t, err)
}

// newEncryptedMember creates a user key for the user of token, wrapped under
// a fresh recovery passphrase, as the plugin does when the user enables
// encryption (CreateUserKey).
func newEncryptedMember(t *testing.T, server *instance, token string) *encryptedMember {
	t.Helper()

	privateKey, publicKey, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	passphrase := "correct horse " + rand.Text()

	wrapped, authKey, err := e2ee.WrapWithPassphrase(passphrase, privateKey, e2ee.UserKeyAD(publicKey))
	require.NoError(t, err)

	params, salt, err := e2ee.ParsePassphraseHeader(wrapped)
	require.NoError(t, err)

	_, err = vaultsyncv1connect.NewUserKeyServiceClient(httpClient, server.apiURL).CreateUserKey(t.Context(), authorized(&vaultsyncv1.CreateUserKeyRequest{
		PublicKey:         publicKey,
		WrappedPrivateKey: wrapped,
		Params: &vaultsyncv1.PassphraseParams{
			Suite: uint32(e2ee.SuiteV2), MemoryKib: params.Memory, Iterations: params.Iterations, Parallelism: uint32(params.Parallelism), Salt: salt,
		},
		AuthKey:       authKey,
		SignPublicKey: bytes.Repeat([]byte{1}, 32),
	}, token))
	require.NoError(t, err)

	return &encryptedMember{token: token, passphrase: passphrase, privateKey: privateKey, publicKey: publicKey, epochKeys: map[uint64][]byte{}}
}

// createEncryptedVault creates an end-to-end encrypted vault without escrow
// owned by member and gives it epochs 1 to epochs, each wrapped to member,
// as the owner's plugin device does (RotateEpoch).
func createEncryptedVault(t *testing.T, server *instance, member *encryptedMember, name string, epochs uint64) *vaultsyncv1.Vault {
	t.Helper()

	// The genesis entry names its creator, so the user id comes first: the
	// user key's row names it.
	connection, err := pgx.Connect(t.Context(), server.databaseDSN)
	require.NoError(t, err)

	var userID uuid.UUID

	err = connection.QueryRow(t.Context(), `SELECT user_id FROM user_keys WHERE public_key = $1`, member.publicKey).Scan(&userID)
	require.NoError(t, connection.Close(t.Context()))
	require.NoError(t, err)

	vaultID := uuid.Must(uuid.NewV7())
	log := logtest.New(t, vaultID, userID, nil)

	response, err := server.vaults().CreateVault(t.Context(), authorized(&vaultsyncv1.CreateVaultRequest{
		Name: name, Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE,
		NewVaultId: vaultID.String(), Genesis: logtest.EntryMessage(log.Entries[0]),
	}, member.token))
	require.NoError(t, err)

	vault := response.Msg.GetVault()
	member.userID = userID.String()
	member.epochKeys = map[uint64][]byte{}
	member.anchorVault(t, server, log)

	keys := vaultsyncv1connect.NewVaultKeyServiceClient(httpClient, server.apiURL)

	var previous []byte

	for epoch := uint64(1); epoch <= epochs; epoch++ {
		epochKey, err := e2ee.GenerateKey()
		require.NoError(t, err)

		commitment, err := e2ee.KeyCommitment(epochKey, vault.GetId(), epoch)
		require.NoError(t, err)

		wrapped, err := e2ee.SealKeySlot(member.publicKey, epochKey, e2ee.KeySlot{
			VaultID: vault.GetId(), Epoch: epoch, RecipientKind: e2ee.RecipientUser, RecipientID: member.userID,
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
				Slots: []*vaultsyncv1.KeySlot{{
					RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER, RecipientId: member.userID, WrappedKey: wrapped,
				}},
			},
		}, member.token))
		require.NoError(t, err, "rotate to epoch %d", epoch)

		member.epochKeys[epoch] = epochKey
		member.allEpochKeys = append(member.allEpochKeys, epochKey)
	}

	return vault
}

// decryptAll pulls the whole change feed of an encrypted vault as a fresh
// plugin device does, and opens every live document's path and content with
// the engine's formats: the path and content under the revision's epoch key,
// and the blob id checked after decryption. It returns the files by plaintext path.
func (member *encryptedMember) decryptAll(t *testing.T, server *instance, vaultID string) map[string]syncedFile {
	t.Helper()

	device := newSyncClient(t, server, member.token, vaultID)
	revisions, _ := device.changes(t, 0, server)

	heads := map[string]*vaultsyncv1.Revision{}
	for _, revision := range revisions {
		heads[revision.GetDocumentId()] = revision
	}

	files := map[string]syncedFile{}

	for _, head := range heads {
		if head.GetDeleted() {
			continue
		}

		epoch := uint64(head.GetEpoch())
		epochKey := member.epochKeys[epoch]
		require.NotNil(t, epochKey, "revision under unknown epoch %d", epoch)

		pathSubkey, err := e2ee.DeriveSubkey(epochKey, e2ee.LabelPath)
		require.NoError(t, err)

		pathAD, err := e2ee.PathAD(vaultID, head.GetDocumentId(), epoch)
		require.NoError(t, err)

		path, err := e2ee.Open(pathSubkey, head.GetPath(), pathAD)
		require.NoError(t, err, "the path decrypts")

		file := syncedFile{Kind: head.GetKind()}

		if blobID := head.GetContentRef().GetBlobId(); len(blobID) > 0 {
			sealed := (&blobClient{token: member.token, vaultID: vaultID, blobID: blobID}).download(t, server)

			contentSubkey, err := e2ee.DeriveSubkey(epochKey, e2ee.LabelContent)
			require.NoError(t, err)

			contentAD, err := e2ee.ContentAD(vaultID, epoch)
			require.NoError(t, err)

			content, err := e2ee.Open(contentSubkey, sealed, contentAD)
			require.NoError(t, err, "the content of %q decrypts", path)

			blobIDSecret, err := e2ee.DeriveSubkey(epochKey, e2ee.LabelBlobIDSecret)
			require.NoError(t, err)

			expected, err := e2ee.BlobID(blobIDSecret, content)
			require.NoError(t, err)
			assert.True(t, hmac.Equal(expected, blobID), "the blob id of %q matches its content", path)

			file.Digest = digest(string(content))
		}

		files[string(path)] = file
	}

	return files
}

// secretNeedles are the byte strings that must never reach the server: the
// plaintext of every name and content, the passphrase, and the private and
// epoch keys in every form the import handles.
func (member *encryptedMember) secretNeedles(t *testing.T, plaintexts ...string) map[string][]byte {
	t.Helper()

	identity, err := e2ee.AgeIdentity(member.privateKey)
	require.NoError(t, err)

	needles := map[string][]byte{
		"passphrase":                    []byte(member.passphrase),
		"private key":                   member.privateKey,
		"private key (age)":             []byte(identity),
		"private key (age, lower case)": []byte(strings.ToLower(identity)),
	}

	for index, key := range member.allEpochKeys {
		needles[fmt.Sprintf("epoch key %d", index)] = key
	}

	for _, plaintext := range plaintexts {
		needles["plaintext "+plaintext] = []byte(plaintext)
	}

	return needles
}

// assertNoSecrets checks that none of needles is in haystack: raw, as hex
// (PostgreSQL's text form of bytea), or base64-encoded at any offset (the
// store's text form of encrypted paths).
func assertNoSecrets(t *testing.T, where string, haystack []byte, needles map[string][]byte) {
	t.Helper()

	lower := bytes.ToLower(haystack)

	for name, needle := range needles {
		assert.False(t, bytes.Contains(haystack, needle), "%s holds the %s", where, name)
		assert.False(t, bytes.Contains(lower, []byte(hex.EncodeToString(needle))), "%s holds the %s as hex", where, name)

		for _, encoded := range base64Forms(needle) {
			assert.False(t, bytes.Contains(haystack, []byte(encoded)), "%s holds the %s as base64", where, name)
		}
	}
}

// base64Forms returns the base64 characters, in the standard and URL
// alphabets, that encode only bytes of needle wherever needle starts
// relative to a 3-byte group.
func base64Forms(needle []byte) []string {
	var forms []string

	for shift := range 3 {
		shifted := append(make([]byte, shift), needle...)

		// Skip the group holding the padding, and the last partial group.
		start, end := 0, len(shifted)/3*4
		if shift > 0 {
			start = 4
		}

		if end-start < 8 {
			continue
		}

		for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding} {
			forms = append(forms, encoding.EncodeToString(shifted)[start:end])
		}
	}

	return forms
}

// databaseText returns every row of every table of the deployment's
// database in PostgreSQL's text form.
func (cluster *deployment) databaseText(t *testing.T) []byte {
	t.Helper()

	conn := cluster.connectDatabase(t)

	rows, err := conn.Query(t.Context(), `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)
	require.NoError(t, err)

	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)
	require.NotEmpty(t, tables)

	var text bytes.Buffer

	for _, table := range tables {
		var dump *string

		require.NoError(t, conn.QueryRow(t.Context(),
			`SELECT string_agg(row::text, E'\n') FROM `+pgx.Identifier{table}.Sanitize()+` AS row`).Scan(&dump), table)

		if dump != nil {
			text.WriteString(*dump + "\n")
		}
	}

	return text.Bytes()
}

// objectsContent returns the bytes of every object in the deployment's
// bucket.
func (cluster *deployment) objectsContent(t *testing.T) []byte {
	t.Helper()

	objects, err := blobstore.New(cluster.objects)
	require.NoError(t, err)

	var all bytes.Buffer

	count := 0

	paginator := s3.NewListObjectsV2Paginator(objects.Client(), &s3.ListObjectsV2Input{Bucket: aws.String(cluster.objects.Bucket)})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(t.Context())
		require.NoError(t, err)

		for _, object := range page.Contents {
			all.WriteString(aws.ToString(object.Key) + "\n")

			body, err := objects.Client().GetObject(t.Context(), &s3.GetObjectInput{Bucket: aws.String(cluster.objects.Bucket), Key: object.Key})
			require.NoError(t, err)

			_, err = all.ReadFrom(body.Body)
			require.NoError(t, err)
			require.NoError(t, body.Body.Close())

			count++
		}
	}

	require.Positive(t, count, "the bucket holds the imported blobs")

	return all.Bytes()
}

func TestImportIntoAnEncryptedVault(t *testing.T) {
	cluster := newDeployment(t)
	flow := cluster.issuer.EnableDeviceFlow(t, cluster.key, authtest.DeviceFlowOptions{})
	binary := buildServer(t)
	server := cluster.start(t, "server", binary, config.OIDCClientIDEnv+"="+authtest.DefaultAudience)
	member := newEncryptedMember(t, server, cluster.token(t, "alice"))

	// Distinctive names and contents, so any plaintext copy is found.
	marker := strings.ToLower(rand.Text())
	files := map[string]string{
		"Journal " + marker + ".md":                      "# Private journal " + marker + "\n\nNothing here may reach the server.\n",
		"Plans " + marker + "/roadmap " + marker + ".md": "- [ ] confidential milestone " + marker + "\n",
		"Plans " + marker + "/empty " + marker + ".md":   "",
		"Attachments/scan " + marker + ".pdf":            "%PDF-1.7 classified " + marker + "\n",
	}

	attachment := bytes.Repeat([]byte("attachment "+marker+" "), 300_000)
	files["Attachments/large "+marker+".bin"] = string(attachment)

	source := t.TempDir()

	for name, content := range files {
		full := filepath.Join(source, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
		require.NoError(t, os.WriteFile(full, []byte(content), 0o600))
	}

	emptyFolder := "Archive " + marker
	require.NoError(t, os.MkdirAll(filepath.Join(source, emptyFolder), 0o755))

	expected := map[string]syncedFile{emptyFolder: {Kind: vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER}}

	for name, content := range files {
		kind := vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB
		if strings.HasSuffix(name, ".md") {
			kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT
		}

		expected[name] = syncedFile{Kind: kind, Digest: digest(content)}
	}

	plaintexts := []string{marker, emptyFolder, "Private journal", "confidential milestone", "classified"}
	for name := range files {
		plaintexts = append(plaintexts, name)
	}

	secrets := t.TempDir()
	importLogs := ""

	t.Run("[P4-13] a device decrypts every file imported into an encrypted vault with the member's passphrase", func(t *testing.T) {
		// Two epochs: content and paths are sealed under the current one,
		// path keys under epoch 1's path_key_secret.
		vault := createEncryptedVault(t, server, member, "Encrypted", 2)

		passphraseFile := filepath.Join(secrets, "passphrase")
		require.NoError(t, os.WriteFile(passphraseFile, []byte(member.passphrase+"\n"), 0o600))

		code, report, logs := cluster.importFolderWithLogs(t, binary, server, flow, "alice", vault.GetId(), source, "-passphrase-file", passphraseFile)
		importLogs += logs

		require.Equal(t, vaultimport.StatusOK, report.Status, report.Error)
		assert.Equal(t, 0, code)
		assert.Equal(t, vaultimport.Counts{Text: 3, Blob: 2, Folder: 1}, report.Imported)

		assert.Equal(t, expected, member.decryptAll(t, server, vault.GetId()))
	})

	t.Run("a device decrypts every file imported with the member's private key", func(t *testing.T) {
		vault := createEncryptedVault(t, server, member, "Encrypted with the key", 1)

		identity, err := e2ee.AgeIdentity(member.privateKey)
		require.NoError(t, err)

		keyFile := filepath.Join(secrets, "identity.txt")
		require.NoError(t, os.WriteFile(keyFile, []byte("# my key\n"+identity+"\n"), 0o600))

		code, report, logs := cluster.importFolderWithLogs(t, binary, server, flow, "alice", vault.GetId(), source, "-private-key-file", keyFile)
		importLogs += logs

		require.Equal(t, vaultimport.StatusOK, report.Status, report.Error)
		assert.Equal(t, 0, code)

		assert.Equal(t, expected, member.decryptAll(t, server, vault.GetId()))
	})

	t.Run("a wrong passphrase imports nothing", func(t *testing.T) {
		vault := createEncryptedVault(t, server, member, "Wrong passphrase", 1)

		passphraseFile := filepath.Join(secrets, "wrong")
		require.NoError(t, os.WriteFile(passphraseFile, []byte("not the passphrase"), 0o600))

		code, report, logs := cluster.importFolderWithLogs(t, binary, server, flow, "alice", vault.GetId(), source, "-passphrase-file", passphraseFile)
		importLogs += logs

		assert.Equal(t, 1, code)
		assert.Equal(t, vaultimport.StatusFailed, report.Status)
		assert.Contains(t, report.Error, "passphrase is wrong")
		assert.Empty(t, member.decryptAll(t, server, vault.GetId()))
	})

	t.Run("P4-16 the database, S3 and the logs hold no plaintext content, path, passphrase or key", func(t *testing.T) {
		needles := member.secretNeedles(t, plaintexts...)

		assertNoSecrets(t, "the database", cluster.databaseText(t), needles)
		assertNoSecrets(t, "S3", cluster.objectsContent(t), needles)
		assertNoSecrets(t, "the server's logs", []byte(server.logs.String()), needles)

		// The import's own logs stay on the operator's machine, but never
		// carry the passphrase or a key either.
		assertNoSecrets(t, "the import's logs", []byte(importLogs), member.secretNeedles(t))
	})
}

// genesis returns the genesis hash of vaultID, as the plugin shows it for
// -genesis (hexadecimal).
func (member *encryptedMember) genesis(vaultID string) string {
	for _, anchor := range member.anchors {
		if anchor.VaultID == vaultID {
			return hex.EncodeToString(anchor.GenesisHash)
		}
	}

	return ""
}
