package e2ee

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"testing/cryptotest"

	"filippo.io/age"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"

	"github.com/solidDoWant/vault-sync/internal/pathkey"
)

// Regenerate testdata/crypto/vectors.json with
//
//	go test ./internal/e2ee -run TestSharedVectors -update
//
// The TypeScript implementation (plugin/src/core/e2ee) asserts the same file.
var update = flag.Bool("update", false, "rewrite testdata/crypto/vectors.json")

var vectorsPath = filepath.Join("..", "..", "testdata", "crypto", "vectors.json")

type hkdfVector struct {
	Name   string `json:"name"`
	IKM    string `json:"ikm"`
	Salt   string `json:"salt"`
	Info   string `json:"info"`
	Length int    `json:"length"`
	OKM    string `json:"okm"`
}

type xchachaVector struct {
	Name       string `json:"name"`
	Key        string `json:"key"`
	Nonce      string `json:"nonce"`
	Plaintext  string `json:"plaintext"`
	AAD        string `json:"aad"`
	Ciphertext string `json:"ciphertext"`
}

type x25519Vector struct {
	Name          string `json:"name"`
	PrivateKey    string `json:"private_key"`
	PublicKey     string `json:"public_key"`
	PeerPublicKey string `json:"peer_public_key"`
	SharedSecret  string `json:"shared_secret"`
}

type standardVectors struct {
	Description       string          `json:"description"`
	HKDFSHA256        []hkdfVector    `json:"hkdf_sha256"`
	XChaCha20Poly1305 []xchachaVector `json:"xchacha20poly1305"`
	X25519            []x25519Vector  `json:"x25519"`
}

type subkeyVector struct {
	Name     string `json:"name"`
	EpochKey string `json:"epoch_key"`
	Label    string `json:"label"`
	Subkey   string `json:"subkey"`
}

type aeadVector struct {
	Name      string `json:"name"`
	Key       string `json:"key"`
	Nonce     string `json:"nonce"`
	Plaintext string `json:"plaintext"`
	AAD       string `json:"aad"`
	Sealed    string `json:"sealed"`
}

// hybridVector is an age file sealed to a hybrid key pair. The private key
// is a fixed seed; the age file comes from the deterministic randomness of
// testing/cryptotest, so an implementation can only open it, not reproduce
// it.
type hybridVector struct {
	Name                string `json:"name"`
	RecipientPrivateKey string `json:"recipient_private_key"`
	RecipientPublicKey  string `json:"recipient_public_key"`
	AgeIdentity         string `json:"age_identity"`
	AgeRecipient        string `json:"age_recipient"`
	Plaintext           string `json:"plaintext"`
	Sealed              string `json:"sealed"`
}

type pathKeyVector struct {
	Name    string `json:"name"`
	Secret  string `json:"secret"`
	Path    string `json:"path"`
	PathKey string `json:"path_key"`
}

type blobIDVector struct {
	Name      string `json:"name"`
	Secret    string `json:"secret"`
	Plaintext string `json:"plaintext"`
	BlobID    string `json:"blob_id"`
}

type passphraseVector struct {
	Name        string `json:"name"`
	Passphrase  string `json:"passphrase"`
	Memory      uint32 `json:"memory"`
	Iterations  uint32 `json:"iterations"`
	Parallelism uint8  `json:"parallelism"`
	Salt        string `json:"salt"`
	Nonce       string `json:"nonce"`
	Secret      string `json:"secret"`
	AAD         string `json:"aad"`
	WrapKey     string `json:"wrap_key"`
	AuthKey     string `json:"auth_key"`
	Wrapped     string `json:"wrapped"`
}

// rejectedVector is a ciphertext that must not open. Key is the symmetric key
// (kind "aead") or the recipient's private key (kind "hybrid"); a
// "passphrase" vector uses Passphrase instead.
type rejectedVector struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Key        string `json:"key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
	AAD        string `json:"aad"`
	Sealed     string `json:"sealed"`
}

type keySlotVector struct {
	Name                string `json:"name"`
	RecipientPrivateKey string `json:"recipient_private_key"`
	RecipientPublicKey  string `json:"recipient_public_key"`
	VaultID             string `json:"vault_id"`
	Epoch               uint64 `json:"epoch"`
	RecipientKind       string `json:"recipient_kind"`
	RecipientID         string `json:"recipient_id"`
	EpochKey            string `json:"epoch_key"`
	AD                  string `json:"ad"`
	Sealed              string `json:"sealed"`
}

func (vector keySlotVector) slot() KeySlot {
	return KeySlot{VaultID: vector.VaultID, Epoch: vector.Epoch, RecipientKind: RecipientKind(vector.RecipientKind), RecipientID: vector.RecipientID}
}

type keyCommitmentVector struct {
	Name       string `json:"name"`
	EpochKey   string `json:"epoch_key"`
	VaultID    string `json:"vault_id"`
	Epoch      uint64 `json:"epoch"`
	Commitment string `json:"commitment"`
}

// rejectedKeySlotVector is a key slot that must not open as the slot it
// names.
type rejectedKeySlotVector struct {
	Name                string `json:"name"`
	RecipientPrivateKey string `json:"recipient_private_key"`
	VaultID             string `json:"vault_id"`
	Epoch               uint64 `json:"epoch"`
	RecipientKind       string `json:"recipient_kind"`
	RecipientID         string `json:"recipient_id"`
	Sealed              string `json:"sealed"`
}

func (vector rejectedKeySlotVector) slot() KeySlot {
	return KeySlot{VaultID: vector.VaultID, Epoch: vector.Epoch, RecipientKind: RecipientKind(vector.RecipientKind), RecipientID: vector.RecipientID}
}

type vectorFile struct {
	Description string             `json:"description"`
	Standards   standardVectors    `json:"standards"`
	Subkeys     []subkeyVector     `json:"subkeys"`
	AEAD        []aeadVector       `json:"aead"`
	Hybrid      []hybridVector     `json:"hybrid"`
	PathKey     []pathKeyVector    `json:"path_key"`
	BlobID      []blobIDVector     `json:"blob_id"`
	Passphrase  []passphraseVector `json:"passphrase"`
	Rejected    []rejectedVector   `json:"rejected"`

	KeySlot                []keySlotVector         `json:"key_slot"`
	KeyCommitment          []keyCommitmentVector   `json:"key_commitment"`
	RejectedKeySlots       []rejectedKeySlotVector `json:"rejected_key_slots"`
	RejectedKeyCommitments []keyCommitmentVector   `json:"rejected_key_commitments"`

	IdentityKeys identityVectors `json:"identity_keys"`
}

// fixed returns n deterministic bytes for a test input named by label.
func fixed(label string, n int) []byte {
	var out []byte
	for counter := byte(0); len(out) < n; counter++ {
		sum := sha256.Sum256(append([]byte("vault-sync test vector "+label), counter))
		out = append(out, sum[:]...)
	}

	return out[:n]
}

// must panics on err; the test using it then fails with the panic.
func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}

	return value
}

func unhex(t *testing.T, value string) []byte {
	t.Helper()

	decoded, err := hex.DecodeString(value)
	require.NoError(t, err)

	return decoded
}

// standards holds published known-answer tests for the primitives the suite
// is built from, so that both languages are pinned to the standards and not
// only to each other.
func standards() standardVectors {
	ikm := bytes.Repeat([]byte{0x0b}, 22)

	xchachaKey := make([]byte, 32)
	for index := range xchachaKey {
		xchachaKey[index] = byte(0x80 + index)
	}

	return standardVectors{
		Description: "Published known-answer tests for the underlying primitives: RFC 5869 appendix A.1 (HKDF-SHA256), draft-irtf-cfrg-xchacha-03 appendix A.3.1 (XChaCha20-Poly1305; ciphertext includes the tag), RFC 7748 section 6.1 (X25519).",
		HKDFSHA256: []hkdfVector{{
			Name:   "RFC 5869 A.1",
			IKM:    hex.EncodeToString(ikm),
			Salt:   "000102030405060708090a0b0c",
			Info:   "f0f1f2f3f4f5f6f7f8f9",
			Length: 42,
			OKM:    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
		}},
		XChaCha20Poly1305: []xchachaVector{{
			Name:       "draft-irtf-cfrg-xchacha-03 A.3.1",
			Key:        hex.EncodeToString(xchachaKey),
			Nonce:      "404142434445464748494a4b4c4d4e4f5051525354555657",
			Plaintext:  hex.EncodeToString([]byte("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.")),
			AAD:        "50515253c0c1c2c3c4c5c6c7",
			Ciphertext: "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49",
		}},
		X25519: []x25519Vector{
			{
				Name:          "RFC 7748 6.1 Alice",
				PrivateKey:    "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
				PublicKey:     "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
				PeerPublicKey: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
				SharedSecret:  "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
			},
			{
				Name:          "RFC 7748 6.1 Bob",
				PrivateKey:    "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
				PublicKey:     "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
				PeerPublicKey: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
				SharedSecret:  "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
			},
		},
	}
}

// generate builds the vector file from fixed inputs with this package.
//
//nolint:funlen,maintidx // One flat list of vectors reads best in one place.
func generate(t *testing.T) vectorFile {
	t.Helper()

	// Hybrid sealing draws its randomness inside age and crypto/mlkem; a
	// fixed global source makes the generated age files reproducible.
	cryptotest.SetGlobalRandom(t, 1)

	file := vectorFile{
		Description: "Cross-language vectors for E2EE cipher suite 2 (SPEC.md section 9.3, docs/design/crypto.md). Binary values are lowercase hex; path and passphrase are strings. Generated by `go test ./internal/e2ee -run TestSharedVectors -update` and asserted by internal/e2ee (Go) and plugin/src/core/e2ee (TypeScript). The aead and passphrase vectors fix the random inputs (nonce, salt): an implementation must produce exactly the given output from them and open it. The hybrid and key_slot vectors are age files sealed with deterministic test randomness: an implementation must open them and derive the given public key and age strings from the private key. Every rejected vector must fail to open.",
		Standards:   standards(),
	}

	// Sub-keys.
	for _, epoch := range []string{"epoch key 1", "epoch key 2"} {
		epochKey := fixed(epoch, KeySize)
		for _, label := range []Label{LabelContent, LabelPath, LabelPathKeySecret, LabelBlobIDSecret} {
			file.Subkeys = append(file.Subkeys, subkeyVector{
				Name:     epoch + " " + string(label),
				EpochKey: hex.EncodeToString(epochKey),
				Label:    string(label),
				Subkey:   hex.EncodeToString(must(DeriveSubkey(epochKey, label))),
			})
		}
	}

	// AEAD.
	aeadCases := []struct {
		name      string
		plaintext []byte
		aad       []byte
	}{
		{"empty plaintext, empty aad", nil, nil},
		{"short note, document id and epoch aad", []byte("# Hello\n\nA note.\n"), []byte("0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e\x00\x00\x00\x01")},
		{"one block plus one byte", fixed("aead block", 65), []byte("aad")},
		{"4 KiB binary", fixed("aead 4k", 4096), fixed("aead 4k aad", 40)},
	}
	for _, testCase := range aeadCases {
		key := fixed("aead key "+testCase.name, KeySize)
		nonce := fixed("aead nonce "+testCase.name, NonceSize)
		file.AEAD = append(file.AEAD, aeadVector{
			Name:      testCase.name,
			Key:       hex.EncodeToString(key),
			Nonce:     hex.EncodeToString(nonce),
			Plaintext: hex.EncodeToString(testCase.plaintext),
			AAD:       hex.EncodeToString(testCase.aad),
			Sealed:    hex.EncodeToString(must(sealWithNonce(key, nonce, testCase.plaintext, testCase.aad))),
		})
	}

	// Hybrid sealing.
	hybridCases := []struct {
		name      string
		plaintext []byte
	}{
		{"epoch key", fixed("sealed epoch key", KeySize)},
		{"empty plaintext", nil},
	}
	for _, testCase := range hybridCases {
		recipient := fixed("hybrid recipient "+testCase.name, PrivateKeySize)
		recipientPublicKey := must(PublicKey(recipient))
		file.Hybrid = append(file.Hybrid, hybridVector{
			Name:                testCase.name,
			RecipientPrivateKey: hex.EncodeToString(recipient),
			RecipientPublicKey:  hex.EncodeToString(recipientPublicKey),
			AgeIdentity:         must(AgeIdentity(recipient)),
			AgeRecipient:        must(AgeRecipient(recipientPublicKey)),
			Plaintext:           hex.EncodeToString(testCase.plaintext),
			Sealed:              hex.EncodeToString(must(SealTo(recipientPublicKey, testCase.plaintext))),
		})
	}

	// path_key: case and normalization variants share a key.
	pathKeySecret := fixed("path_key_secret", KeySize)
	for _, testCase := range []struct{ name, path string }{
		{"ascii", "Notes/Daily/2026-10-21.md"},
		{"ascii, other case", "notes/daily/2026-10-21.MD"},
		{"sharp s", "Straße/plan.md"},
		{"sharp s folded", "STRASSE/plan.md"},
		{"precomposed e acute", "Café.md"},
		{"decomposed e acute", "Café.md"},
		{"emoji", "ideas/\U0001F4A1.md"},
		{"empty", ""},
	} {
		file.PathKey = append(file.PathKey, pathKeyVector{
			Name:    testCase.name,
			Secret:  hex.EncodeToString(pathKeySecret),
			Path:    testCase.path,
			PathKey: hex.EncodeToString(must(PathKey(pathKeySecret, testCase.path))),
		})
	}

	// blob_id.
	blobIDSecret := fixed("blob_id_secret", KeySize)
	for _, testCase := range []struct {
		name      string
		plaintext []byte
	}{
		{"empty", nil},
		{"text", []byte("# Hello\n")},
		{"1 KiB binary", fixed("blob 1k", 1024)},
	} {
		file.BlobID = append(file.BlobID, blobIDVector{
			Name:      testCase.name,
			Secret:    hex.EncodeToString(blobIDSecret),
			Plaintext: hex.EncodeToString(testCase.plaintext),
			BlobID:    hex.EncodeToString(must(BlobID(blobIDSecret, testCase.plaintext))),
		})
	}

	// Passphrase wrapping.
	minimum := Argon2Params{Memory: MinArgon2Memory, Iterations: MinArgon2Iterations, Parallelism: 1}

	passphraseCases := []struct {
		name       string
		passphrase string
		params     Argon2Params
		aad        []byte
	}{
		{"default parameters", "correct horse battery staple", DefaultArgon2Params, []byte("user 0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e")},
		{"minimum parameters, empty aad", "correct horse battery staple", minimum, nil},
		{"two lanes", "correct horse battery staple", Argon2Params{Memory: MinArgon2Memory, Iterations: 2, Parallelism: 2}, nil},
		{"precomposed passphrase", "Café über alles", minimum, nil},
		{"decomposed passphrase", "Café über alles", minimum, nil},
		// U+10EFD (Unicode 15.0, combining class 220) does not block the
		// acute accent from composing with the e.
		{"Unicode 15.0 mark, precomposed passphrase", "\u00e9\U00010EFD pass", minimum, nil},
		{"Unicode 15.0 mark, decomposed passphrase", "e\U00010EFD\u0301 pass", minimum, nil},
	}
	for _, testCase := range passphraseCases {
		// The two normalization forms share the salt and nonce, so equal
		// wrapped values show they derive the same key.
		salt := fixed("passphrase salt "+testCase.params.String(), SaltSize)
		nonce := fixed("passphrase nonce "+testCase.params.String(), NonceSize)
		secret := fixed("passphrase secret", KeySize)
		wrapped, keys, err := wrapWith(testCase.passphrase, testCase.params, salt, nonce, secret, testCase.aad)
		require.NoError(t, err)

		file.Passphrase = append(file.Passphrase, passphraseVector{
			Name:        testCase.name,
			Passphrase:  testCase.passphrase,
			Memory:      testCase.params.Memory,
			Iterations:  testCase.params.Iterations,
			Parallelism: testCase.params.Parallelism,
			Salt:        hex.EncodeToString(salt),
			Nonce:       hex.EncodeToString(nonce),
			Secret:      hex.EncodeToString(secret),
			AAD:         hex.EncodeToString(testCase.aad),
			WrapKey:     hex.EncodeToString(keys.WrapKey),
			AuthKey:     hex.EncodeToString(keys.AuthKey),
			Wrapped:     hex.EncodeToString(wrapped),
		})
	}

	file.Rejected = rejected(t, file)

	generateKeySlots(&file)

	file.IdentityKeys = generateIdentityVectors(t)

	return file
}

const (
	vectorVaultID      = "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e"
	vectorOtherVaultID = "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0f"
	vectorUserID       = "0190d6e5-1a2b-7c3d-8e4f-5a6b7c8d9e0f"
	vectorOtherUserID  = "0190d6e5-1a2b-7c3d-8e4f-5a6b7c8d9e10"
	vectorEscrowID     = "escrow-2026"
)

// generateKeySlots adds the key slot and key commitment vectors, and the
// slots and commitments that must be refused.
//
//nolint:funlen // One flat list of vectors reads best in one place.
func generateKeySlots(file *vectorFile) {
	slotCases := []struct {
		name string
		slot KeySlot
	}{
		{"user, epoch 1", KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientUser, RecipientID: vectorUserID}},
		{"escrow, epoch 2", KeySlot{VaultID: vectorVaultID, Epoch: 2, RecipientKind: RecipientEscrow, RecipientID: vectorEscrowID}},
		{"user, epoch above 32 bits", KeySlot{VaultID: vectorVaultID, Epoch: 1 << 32, RecipientKind: RecipientUser, RecipientID: vectorUserID}},
	}
	for _, testCase := range slotCases {
		recipient := fixed("key slot recipient "+testCase.name, PrivateKeySize)
		epochKey := fixed("key slot epoch key "+testCase.name, KeySize)
		recipientPublicKey := must(PublicKey(recipient))
		file.KeySlot = append(file.KeySlot, keySlotVector{
			Name:                testCase.name,
			RecipientPrivateKey: hex.EncodeToString(recipient),
			RecipientPublicKey:  hex.EncodeToString(recipientPublicKey),
			VaultID:             testCase.slot.VaultID,
			Epoch:               testCase.slot.Epoch,
			RecipientKind:       string(testCase.slot.RecipientKind),
			RecipientID:         testCase.slot.RecipientID,
			EpochKey:            hex.EncodeToString(epochKey),
			AD:                  hex.EncodeToString(must(testCase.slot.AD())),
			Sealed:              hex.EncodeToString(must(SealKeySlot(recipientPublicKey, epochKey, testCase.slot))),
		})
	}

	commitmentCases := []struct {
		name    string
		vaultID string
		epoch   uint64
	}{
		{"epoch 1", vectorVaultID, 1},
		{"epoch 2", vectorVaultID, 2},
		{"other vault, epoch 1", vectorOtherVaultID, 1},
		{"epoch above 32 bits", vectorVaultID, 1 << 32},
	}

	commitmentKey := fixed("key commitment epoch key", KeySize)

	for _, testCase := range commitmentCases {
		file.KeyCommitment = append(file.KeyCommitment, keyCommitmentVector{
			Name:       testCase.name,
			EpochKey:   hex.EncodeToString(commitmentKey),
			VaultID:    testCase.vaultID,
			Epoch:      testCase.epoch,
			Commitment: hex.EncodeToString(must(KeyCommitment(commitmentKey, testCase.vaultID, testCase.epoch))),
		})
	}

	// Slots opened as another slot: the user slot of epoch 1 under every
	// field changed.
	userVec := file.KeySlot[0]
	rejectSlot := func(name string, slot KeySlot, recipientPrivateKey string, sealed []byte) {
		file.RejectedKeySlots = append(file.RejectedKeySlots, rejectedKeySlotVector{
			Name:                name,
			RecipientPrivateKey: recipientPrivateKey,
			VaultID:             slot.VaultID,
			Epoch:               slot.Epoch,
			RecipientKind:       string(slot.RecipientKind),
			RecipientID:         slot.RecipientID,
			Sealed:              hex.EncodeToString(sealed),
		})
	}
	userSlot := userVec.slot()
	userSealed := must(hex.DecodeString(userVec.Sealed))
	withSlot := func(change func(*KeySlot)) KeySlot {
		slot := userSlot
		change(&slot)

		return slot
	}

	rejectSlot("other vault", withSlot(func(slot *KeySlot) { slot.VaultID = vectorOtherVaultID }), userVec.RecipientPrivateKey, userSealed)
	rejectSlot("other epoch", withSlot(func(slot *KeySlot) { slot.Epoch = 2 }), userVec.RecipientPrivateKey, userSealed)
	rejectSlot("epoch differing above 32 bits", withSlot(func(slot *KeySlot) { slot.Epoch = 1 + 1<<32 }), userVec.RecipientPrivateKey, userSealed)
	rejectSlot("other recipient id", withSlot(func(slot *KeySlot) { slot.RecipientID = vectorOtherUserID }), userVec.RecipientPrivateKey, userSealed)
	rejectSlot("other recipient kind, same id", withSlot(func(slot *KeySlot) { slot.RecipientKind = RecipientEscrow }), userVec.RecipientPrivateKey, userSealed)
	rejectSlot("other recipient key", userSlot, hex.EncodeToString(fixed("key slot other recipient", PrivateKeySize)), userSealed)

	escrowVec := file.KeySlot[1]
	escrowSealed := must(hex.DecodeString(escrowVec.Sealed))
	rejectSlot("escrow slot as a user slot", KeySlot{VaultID: escrowVec.VaultID, Epoch: escrowVec.Epoch, RecipientKind: RecipientUser, RecipientID: vectorUserID}, escrowVec.RecipientPrivateKey, escrowSealed)
	rejectSlot("escrow slot, other escrow id", KeySlot{VaultID: escrowVec.VaultID, Epoch: escrowVec.Epoch, RecipientKind: RecipientEscrow, RecipientID: vectorEscrowID + "x"}, escrowVec.RecipientPrivateKey, escrowSealed)

	// Age files to the recipient whose payload is not a 32-byte key followed
	// by exactly the slot's associated data.
	recipientPublicKey := must(hex.DecodeString(userVec.RecipientPublicKey))
	userEpochKey := must(hex.DecodeString(userVec.EpochKey))
	userAD := must(userSlot.AD())

	for _, size := range []int{0, KeySize - 1, KeySize + 1} {
		rejectSlot(fmt.Sprintf("%d-byte key", size), userSlot, userVec.RecipientPrivateKey,
			must(SealTo(recipientPublicKey, slices.Concat(fixed("key slot short key", size), userAD))))
	}

	rejectSlot("epoch key without associated data", userSlot, userVec.RecipientPrivateKey, must(SealTo(recipientPublicKey, userEpochKey)))
	rejectSlot("associated data without the key-slot label", userSlot, userVec.RecipientPrivateKey,
		must(SealTo(recipientPublicKey, slices.Concat(userEpochKey, userAD[len(keySlotLabel):]))))
	rejectSlot("associated data with a trailing byte", userSlot, userVec.RecipientPrivateKey,
		must(SealTo(recipientPublicKey, slices.Concat(userEpochKey, userAD, []byte{0x00}))))
	rejectSlot("associated data before the key", userSlot, userVec.RecipientPrivateKey,
		must(SealTo(recipientPublicKey, slices.Concat(userAD, userEpochKey))))

	// Commitments that must not verify.
	commitVec := file.KeyCommitment[0]
	commitment := must(hex.DecodeString(commitVec.Commitment))
	rejectCommitment := func(name, epochKey, vaultID string, epoch uint64, commitment []byte) {
		file.RejectedKeyCommitments = append(file.RejectedKeyCommitments, keyCommitmentVector{
			Name: name, EpochKey: epochKey, VaultID: vaultID, Epoch: epoch, Commitment: hex.EncodeToString(commitment),
		})
	}

	rejectCommitment("other epoch key", hex.EncodeToString(fixed("key commitment other epoch key", KeySize)), commitVec.VaultID, commitVec.Epoch, commitment)
	rejectCommitment("other vault", commitVec.EpochKey, vectorOtherVaultID, commitVec.Epoch, commitment)
	rejectCommitment("other epoch", commitVec.EpochKey, commitVec.VaultID, 2, commitment)
	rejectCommitment("truncated by one byte", commitVec.EpochKey, commitVec.VaultID, commitVec.Epoch, commitment[:len(commitment)-1])
	rejectCommitment("empty", commitVec.EpochKey, commitVec.VaultID, commitVec.Epoch, nil)
	rejectCommitment("flipped bit", commitVec.EpochKey, commitVec.VaultID, commitVec.Epoch, flip(commitment, len(commitment)-1))
	rejectCommitment("extended by one byte", commitVec.EpochKey, commitVec.VaultID, commitVec.Epoch, append(slices.Clone(commitment), 0x00))
}

func (params Argon2Params) String() string {
	return hex.EncodeToString(binary.BigEndian.AppendUint32(binary.BigEndian.AppendUint32([]byte{params.Parallelism}, params.Memory), params.Iterations))
}

// rejected derives ciphertexts that must not open from valid vectors. The
// "other suite" vectors are authenticated as if their version byte were
// valid, so only the suite check can refuse them; likewise the out-of-bounds
// Argon2id vectors authenticate under their own parameters.
//
//nolint:funlen // One flat list of vectors reads best in one place.
func rejected(t *testing.T, file vectorFile) []rejectedVector {
	t.Helper()

	var out []rejectedVector

	add := func(name, kind, key, passphrase string, aad, sealed []byte) {
		out = append(out, rejectedVector{Name: name, Kind: kind, Key: key, Passphrase: passphrase, AAD: hex.EncodeToString(aad), Sealed: hex.EncodeToString(sealed)})
	}

	// AEAD, from the document vector.
	aeadVec := file.AEAD[1]
	key, nonce := unhex(t, aeadVec.Key), unhex(t, aeadVec.Nonce)
	plaintext, aad, sealed := unhex(t, aeadVec.Plaintext), unhex(t, aeadVec.AAD), unhex(t, aeadVec.Sealed)

	for _, version := range []byte{0x00, 0x01, 0x03, 0xff} {
		add("aead: suite "+hex.EncodeToString([]byte{version}), "aead", aeadVec.Key, "", aad,
			must(sealAfterHeader([]byte{version}, key, nonce, plaintext, aad)))
	}

	add("aead: modified aad", "aead", aeadVec.Key, "", append(slices.Clone(aad[:len(aad)-1]), aad[len(aad)-1]^0x01), sealed)
	add("aead: aad dropped", "aead", aeadVec.Key, "", nil, sealed)
	add("aead: tag truncated by one byte", "aead", aeadVec.Key, "", aad, sealed[:len(sealed)-1])
	add("aead: tag removed", "aead", aeadVec.Key, "", aad, sealed[:len(sealed)-TagSize])
	add("aead: version byte only", "aead", aeadVec.Key, "", aad, sealed[:1])
	add("aead: empty", "aead", aeadVec.Key, "", aad, nil)
	add("aead: flipped ciphertext bit", "aead", aeadVec.Key, "", aad, flip(sealed, 1+NonceSize))
	add("aead: flipped nonce bit", "aead", aeadVec.Key, "", aad, flip(sealed, 1))
	add("aead: flipped tag bit", "aead", aeadVec.Key, "", aad, flip(sealed, len(sealed)-1))
	add("aead: wrong key", "aead", hex.EncodeToString(fixed("wrong key", KeySize)), "", aad, sealed)

	// Hybrid, from the epoch key vector.
	hybridVec := file.Hybrid[0]
	hybridKey := hybridVec.RecipientPrivateKey
	box := unhex(t, hybridVec.Sealed)
	boxPublicKey := unhex(t, hybridVec.RecipientPublicKey)
	headerEnd := bytes.Index(box, []byte("\n--- ")) + 1
	macEnd := headerEnd + bytes.IndexByte(box[headerEnd:], '\n') + 1

	addHybrid := func(name string, sealed []byte) {
		add("hybrid: "+name, "hybrid", hybridKey, "", nil, sealed)
	}

	addHybrid("other age version", bytes.Replace(box, []byte("age-encryption.org/v1"), []byte("age-encryption.org/v2"), 1))
	addHybrid("other stanza type", bytes.Replace(box, []byte("-> mlkem768x25519 "), []byte("-> mlkem768x25518 "), 1))
	addHybrid("flipped encapsulated key bit", flip(box, len("age-encryption.org/v1\n-> mlkem768x25519 ")+100))
	addHybrid("flipped header MAC bit", flipBase64(box, headerEnd+len("--- ")+10))
	addHybrid("flipped payload nonce bit", flip(box, macEnd))
	addHybrid("flipped payload bit", flip(box, macEnd+16))
	addHybrid("flipped payload tag bit", flip(box, len(box)-1))
	addHybrid("payload truncated by one byte", box[:len(box)-1])
	addHybrid("payload tag removed", box[:len(box)-TagSize])
	addHybrid("header only", box[:macEnd])
	addHybrid("empty", nil)
	add("hybrid: other recipient", "hybrid", hex.EncodeToString(fixed("hybrid other recipient", PrivateKeySize)), "", nil, box)

	// A classic X25519 age file to the same person must not open: only the
	// hybrid recipient type is accepted.
	classic := must(age.GenerateX25519Identity())

	var classicFile bytes.Buffer

	classicWriter := must(age.Encrypt(&classicFile, classic.Recipient()))
	must(classicWriter.Write(unhex(t, hybridVec.Plaintext)))
	require.NoError(t, classicWriter.Close())
	addHybrid("classic X25519 recipient", classicFile.Bytes())

	// A well-formed file one byte over the bound.
	oversized := must(SealTo(boxPublicKey, fixed("hybrid oversized", MaxSealedSize-len(box)+KeySize+1)))
	require.Len(t, oversized, MaxSealedSize+1)
	addHybrid(fmt.Sprintf("%d bytes", MaxSealedSize+1), oversized)

	// Passphrase, from the minimum-parameter vector.
	passVec := file.Passphrase[1]
	salt, passNonce := unhex(t, passVec.Salt), unhex(t, passVec.Nonce)
	secret, wrapped := unhex(t, passVec.Secret), unhex(t, passVec.Wrapped)

	wrapHeader := func(version byte, params Argon2Params) []byte {
		header := []byte{version}
		header = binary.BigEndian.AppendUint32(header, params.Memory)
		header = binary.BigEndian.AppendUint32(header, params.Iterations)
		header = append(header, params.Parallelism)

		return append(header, salt...)
	}
	wrapAs := func(version byte, params Argon2Params) []byte {
		// Out-of-bounds parameters cannot go through DerivePassphraseKeys.
		stretched := argon2.IDKey([]byte(passVec.Passphrase), salt, params.Iterations, params.Memory, params.Parallelism, KeySize)
		wrapKey := must(hkdf.Key(sha256.New, stretched, nil, passphraseWrapInfo, KeySize))

		return must(sealAfterHeader(wrapHeader(version, params), wrapKey, passNonce, secret, nil))
	}
	params := Argon2Params{Memory: passVec.Memory, Iterations: passVec.Iterations, Parallelism: passVec.Parallelism}

	add("passphrase: suite 01", "passphrase", "", passVec.Passphrase, nil, wrapAs(0x01, params))
	add("passphrase: suite 03", "passphrase", "", passVec.Passphrase, nil, wrapAs(0x03, params))
	add("passphrase: wrong passphrase", "passphrase", "", passVec.Passphrase+" ", nil, wrapped)
	// Sealed under the key the passphrase would derive without the Unicode
	// 15.0 rule, so only that rule refuses it. U+1ADD is assigned in Unicode 17.
	const unassignedPassphrase = "\u00e9\u1add pass"
	add("passphrase: code point not assigned in Unicode 15.0", "passphrase", "", unassignedPassphrase, nil,
		must(sealAfterHeader(wrapHeader(SuiteV2, params),
			must(hkdf.Key(sha256.New, argon2.IDKey([]byte(unassignedPassphrase), salt, params.Iterations, params.Memory, params.Parallelism, KeySize), nil, passphraseWrapInfo, KeySize)),
			passNonce, secret, nil)))
	add("passphrase: sealed under the auth key", "passphrase", "", passVec.Passphrase, nil,
		must(sealAfterHeader(wrapped[:passphraseHeaderSize], unhex(t, passVec.AuthKey), passNonce, secret, nil)))
	add("passphrase: aad added", "passphrase", "", passVec.Passphrase, []byte("user"), wrapped)
	add("passphrase: tag truncated by one byte", "passphrase", "", passVec.Passphrase, nil, wrapped[:len(wrapped)-1])
	add("passphrase: tag removed", "passphrase", "", passVec.Passphrase, nil, wrapped[:len(wrapped)-TagSize])
	add("passphrase: header only", "passphrase", "", passVec.Passphrase, nil, wrapped[:passphraseHeaderSize])
	add("passphrase: flipped salt bit", "passphrase", "", passVec.Passphrase, nil, flip(wrapped, 10))
	add("passphrase: iterations changed in header", "passphrase", "", passVec.Passphrase, nil,
		slices.Concat(wrapHeader(SuiteV2, Argon2Params{Memory: params.Memory, Iterations: params.Iterations + 1, Parallelism: params.Parallelism}), wrapped[passphraseHeaderSize:]))
	add("passphrase: memory below minimum", "passphrase", "", passVec.Passphrase, nil,
		wrapAs(SuiteV2, Argon2Params{Memory: MinArgon2Memory - 1, Iterations: 2, Parallelism: 1}))
	add("passphrase: iterations below minimum", "passphrase", "", passVec.Passphrase, nil,
		wrapAs(SuiteV2, Argon2Params{Memory: MinArgon2Memory, Iterations: MinArgon2Iterations - 1, Parallelism: 1}))
	add("passphrase: parallelism above maximum", "passphrase", "", passVec.Passphrase, nil,
		wrapAs(SuiteV2, Argon2Params{Memory: MinArgon2Memory, Iterations: 2, Parallelism: MaxArgon2Parallelism + 1}))
	// Deriving these would cost the bounds they exceed, so their tags are
	// arbitrary: an implementation must refuse them before deriving.
	add("passphrase: memory above maximum", "passphrase", "", passVec.Passphrase, nil,
		slices.Concat(wrapHeader(SuiteV2, Argon2Params{Memory: MaxArgon2Memory + 1, Iterations: 2, Parallelism: 1}), wrapped[passphraseHeaderSize:]))
	add("passphrase: iterations above maximum", "passphrase", "", passVec.Passphrase, nil,
		slices.Concat(wrapHeader(SuiteV2, Argon2Params{Memory: MinArgon2Memory, Iterations: MaxArgon2Iterations + 1, Parallelism: 1}), wrapped[passphraseHeaderSize:]))
	add("passphrase: parallelism zero", "passphrase", "", passVec.Passphrase, nil,
		slices.Concat(wrapHeader(SuiteV2, Argon2Params{Memory: MinArgon2Memory, Iterations: 2, Parallelism: 0}), wrapped[passphraseHeaderSize:]))
	add("passphrase: memory 4 GiB", "passphrase", "", passVec.Passphrase, nil,
		slices.Concat(wrapHeader(SuiteV2, Argon2Params{Memory: 0xffffffff, Iterations: 2, Parallelism: 1}), wrapped[passphraseHeaderSize:]))

	return out
}

// flipBase64 changes the base64 character at index to another valid one.
func flipBase64(data []byte, index int) []byte {
	out := slices.Clone(data)
	if out[index] == 'A' {
		out[index] = 'B'
	} else {
		out[index] = 'A'
	}

	return out
}

func flip(data []byte, index int) []byte {
	out := slices.Clone(data)
	out[index] ^= 0x01

	return out
}

func loadVectorFile(t *testing.T) vectorFile {
	t.Helper()

	data, err := os.ReadFile(vectorsPath)
	require.NoError(t, err)

	var file vectorFile
	require.NoError(t, json.Unmarshal(data, &file))

	return file
}

// TestSharedVectorsAreCurrent fails when the committed file differs from what
// the generator produces, so a format change cannot ship with stale vectors.
func TestSharedVectorsAreCurrent(t *testing.T) {
	generated := generate(t)

	if *update {
		data, err := json.MarshalIndent(generated, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.MkdirAll(filepath.Dir(vectorsPath), 0o755))
		require.NoError(t, os.WriteFile(vectorsPath, append(data, '\n'), 0o644)) //nolint:gosec // A committed test fixture.
	}

	assert.Equal(t, generated, loadVectorFile(t))
}

func TestSharedVectors(t *testing.T) {
	file := loadVectorFile(t)

	t.Run("standards", func(t *testing.T) {
		for _, vector := range file.Standards.HKDFSHA256 {
			t.Run(vector.Name, func(t *testing.T) {
				okm, err := hkdf.Key(sha256.New, unhex(t, vector.IKM), unhex(t, vector.Salt), string(unhex(t, vector.Info)), vector.Length)
				require.NoError(t, err)
				assert.Equal(t, vector.OKM, hex.EncodeToString(okm))
			})
		}

		for _, vector := range file.Standards.XChaCha20Poly1305 {
			t.Run(vector.Name, func(t *testing.T) {
				aead, err := chacha20poly1305.NewX(unhex(t, vector.Key))
				require.NoError(t, err)
				assert.Equal(t, vector.Ciphertext, hex.EncodeToString(aead.Seal(nil, unhex(t, vector.Nonce), unhex(t, vector.Plaintext), unhex(t, vector.AAD))))
			})
		}

		for _, vector := range file.Standards.X25519 {
			t.Run(vector.Name, func(t *testing.T) {
				private := must(ecdh.X25519().NewPrivateKey(unhex(t, vector.PrivateKey)))
				assert.Equal(t, vector.PublicKey, hex.EncodeToString(private.PublicKey().Bytes()))
				peer := must(ecdh.X25519().NewPublicKey(unhex(t, vector.PeerPublicKey)))
				assert.Equal(t, vector.SharedSecret, hex.EncodeToString(must(private.ECDH(peer))))
			})
		}
	})

	t.Run("subkeys", func(t *testing.T) {
		require.NotEmpty(t, file.Subkeys)

		for _, vector := range file.Subkeys {
			t.Run(vector.Name, func(t *testing.T) {
				subkey, err := DeriveSubkey(unhex(t, vector.EpochKey), Label(vector.Label))
				require.NoError(t, err)
				assert.Equal(t, vector.Subkey, hex.EncodeToString(subkey))
			})
		}
	})

	t.Run("aead", func(t *testing.T) {
		require.NotEmpty(t, file.AEAD)

		for _, vector := range file.AEAD {
			t.Run(vector.Name, func(t *testing.T) {
				key, aad := unhex(t, vector.Key), unhex(t, vector.AAD)
				sealed := must(sealWithNonce(key, unhex(t, vector.Nonce), unhex(t, vector.Plaintext), aad))
				assert.Equal(t, vector.Sealed, hex.EncodeToString(sealed))

				plaintext := must(Open(key, unhex(t, vector.Sealed), aad))
				assert.Equal(t, vector.Plaintext, hex.EncodeToString(plaintext))
			})
		}
	})

	t.Run("hybrid", func(t *testing.T) {
		require.NotEmpty(t, file.Hybrid)

		for _, vector := range file.Hybrid {
			t.Run(vector.Name, func(t *testing.T) {
				recipient := unhex(t, vector.RecipientPrivateKey)
				assert.Equal(t, vector.RecipientPublicKey, hex.EncodeToString(must(PublicKey(recipient))))
				assert.Equal(t, vector.AgeIdentity, must(AgeIdentity(recipient)))
				assert.Equal(t, vector.AgeRecipient, must(AgeRecipient(unhex(t, vector.RecipientPublicKey))))

				// The age strings are age's own encoding of the raw keys.
				identity := must(age.ParseHybridIdentity(vector.AgeIdentity))
				assert.Equal(t, vector.AgeRecipient, identity.Recipient().String())

				plaintext := must(OpenFrom(recipient, unhex(t, vector.Sealed)))
				assert.Equal(t, vector.Plaintext, hex.EncodeToString(plaintext))

				// age itself opens it with the identity.
				reader := must(age.Decrypt(bytes.NewReader(unhex(t, vector.Sealed)), identity))
				assert.Equal(t, vector.Plaintext, hex.EncodeToString(must(io.ReadAll(reader))))
			})
		}
	})

	t.Run("path_key", func(t *testing.T) {
		require.NotEmpty(t, file.PathKey)

		for _, vector := range file.PathKey {
			t.Run(vector.Name, func(t *testing.T) {
				assert.Equal(t, vector.PathKey, hex.EncodeToString(must(PathKey(unhex(t, vector.Secret), vector.Path))))
			})
		}
	})

	t.Run("blob_id", func(t *testing.T) {
		require.NotEmpty(t, file.BlobID)

		for _, vector := range file.BlobID {
			t.Run(vector.Name, func(t *testing.T) {
				assert.Equal(t, vector.BlobID, hex.EncodeToString(must(BlobID(unhex(t, vector.Secret), unhex(t, vector.Plaintext)))))
			})
		}
	})

	t.Run("passphrase", func(t *testing.T) {
		require.NotEmpty(t, file.Passphrase)

		for _, vector := range file.Passphrase {
			t.Run(vector.Name, func(t *testing.T) {
				params := Argon2Params{Memory: vector.Memory, Iterations: vector.Iterations, Parallelism: vector.Parallelism}
				aad := unhex(t, vector.AAD)
				salt := unhex(t, vector.Salt)
				wrapped, keys, err := wrapWith(vector.Passphrase, params, salt, unhex(t, vector.Nonce), unhex(t, vector.Secret), aad)
				require.NoError(t, err)
				assert.Equal(t, vector.Wrapped, hex.EncodeToString(wrapped))
				assert.Equal(t, vector.WrapKey, hex.EncodeToString(keys.WrapKey))
				assert.Equal(t, vector.AuthKey, hex.EncodeToString(keys.AuthKey))

				// The keys follow docs/design/crypto.md, computed here from the
				// primitives and the documented labels, not by the package.
				stretched := argon2.IDKey([]byte(pathkey.NFC(vector.Passphrase)), salt, vector.Iterations, vector.Memory, vector.Parallelism, KeySize)
				assert.Equal(t, vector.WrapKey, hex.EncodeToString(must(hkdf.Key(sha256.New, stretched, nil, "vault-sync/v1/passphrase/wrap", KeySize))))
				assert.Equal(t, vector.AuthKey, hex.EncodeToString(must(hkdf.Key(sha256.New, stretched, nil, "vault-sync/v1/passphrase/auth", KeySize))))

				secret := must(UnwrapWithPassphrase(vector.Passphrase, unhex(t, vector.Wrapped), aad))
				assert.Equal(t, vector.Secret, hex.EncodeToString(secret))

				parsedParams, parsedSalt, err := ParsePassphraseHeader(unhex(t, vector.Wrapped))
				require.NoError(t, err)
				assert.Equal(t, params, parsedParams)
				assert.Equal(t, vector.Salt, hex.EncodeToString(parsedSalt))

				secret = must(UnwrapWithKey(unhex(t, vector.WrapKey), unhex(t, vector.Wrapped), aad))
				assert.Equal(t, vector.Secret, hex.EncodeToString(secret))
			})
		}
	})

	// The pairs share their salt and nonce, so equal wrapped values show that
	// both normalization forms of a passphrase derive the same key.
	t.Run("passphrase normalization pairs", func(t *testing.T) {
		wrapped := map[string]string{}
		for _, vector := range file.Passphrase {
			wrapped[vector.Name] = vector.Wrapped
		}

		for _, pair := range [][2]string{
			{"precomposed passphrase", "decomposed passphrase"},
			{"Unicode 15.0 mark, precomposed passphrase", "Unicode 15.0 mark, decomposed passphrase"},
		} {
			require.Contains(t, wrapped, pair[0])
			require.Contains(t, wrapped, pair[1])
			assert.Equal(t, wrapped[pair[0]], wrapped[pair[1]], pair[1])
		}
	})

	t.Run("key slot", func(t *testing.T) {
		require.NotEmpty(t, file.KeySlot)

		for _, vector := range file.KeySlot {
			t.Run(vector.Name, func(t *testing.T) {
				slot := vector.slot()

				// The associated data follows docs/design/crypto.md, built here
				// from the documented layout, not by the package.
				assert.Equal(t, vector.AD, hex.EncodeToString(documentedSlotAD(t, vector)))
				assert.Equal(t, vector.AD, hex.EncodeToString(must(slot.AD())))

				assert.Equal(t, vector.RecipientPublicKey, hex.EncodeToString(must(PublicKey(unhex(t, vector.RecipientPrivateKey)))))

				// The slot is an age file whose payload is the epoch key
				// followed by the documented associated data.
				payload := must(OpenFrom(unhex(t, vector.RecipientPrivateKey), unhex(t, vector.Sealed)))
				assert.Equal(t, vector.EpochKey+vector.AD, hex.EncodeToString(payload))

				epochKey := must(OpenKeySlot(unhex(t, vector.RecipientPrivateKey), unhex(t, vector.Sealed), slot))
				assert.Equal(t, vector.EpochKey, hex.EncodeToString(epochKey))
			})
		}
	})

	t.Run("key commitment", func(t *testing.T) {
		require.NotEmpty(t, file.KeyCommitment)

		for _, vector := range file.KeyCommitment {
			t.Run(vector.Name, func(t *testing.T) {
				epochKey := unhex(t, vector.EpochKey)

				// HMAC-SHA256 over the documented layout, not computed by the
				// package.
				documented := hmac.New(sha256.New, epochKey)
				documented.Write([]byte("vault-sync/v1/key-commitment"))
				documented.Write(uuidBytes(t, vector.VaultID))
				documented.Write(binary.BigEndian.AppendUint64(nil, vector.Epoch))
				assert.Equal(t, vector.Commitment, hex.EncodeToString(documented.Sum(nil)))

				assert.Equal(t, vector.Commitment, hex.EncodeToString(must(KeyCommitment(epochKey, vector.VaultID, vector.Epoch))))
				require.NoError(t, VerifyKeyCommitment(epochKey, unhex(t, vector.Commitment), vector.VaultID, vector.Epoch))
			})
		}
	})

	t.Run("rejected key slots", func(t *testing.T) {
		require.NotEmpty(t, file.RejectedKeySlots)

		for _, vector := range file.RejectedKeySlots {
			t.Run(vector.Name, func(t *testing.T) {
				_, err := OpenKeySlot(unhex(t, vector.RecipientPrivateKey), unhex(t, vector.Sealed), vector.slot())
				require.ErrorIs(t, err, ErrDecrypt)
			})
		}
	})

	t.Run("rejected key commitments", func(t *testing.T) {
		require.NotEmpty(t, file.RejectedKeyCommitments)

		for _, vector := range file.RejectedKeyCommitments {
			t.Run(vector.Name, func(t *testing.T) {
				err := VerifyKeyCommitment(unhex(t, vector.EpochKey), unhex(t, vector.Commitment), vector.VaultID, vector.Epoch)
				require.ErrorIs(t, err, ErrKeyCommitment)
			})
		}
	})

	t.Run("rejected", func(t *testing.T) {
		require.NotEmpty(t, file.Rejected)

		for _, vector := range file.Rejected {
			t.Run(vector.Name, func(t *testing.T) {
				sealed, aad := unhex(t, vector.Sealed), unhex(t, vector.AAD)

				var err error

				switch vector.Kind {
				case "aead":
					_, err = Open(unhex(t, vector.Key), sealed, aad)
				case "hybrid":
					require.Empty(t, aad)

					_, err = OpenFrom(unhex(t, vector.Key), sealed)
				case "passphrase":
					_, err = UnwrapWithPassphrase(vector.Passphrase, sealed, aad)
				default:
					require.Failf(t, "unknown kind", "%q", vector.Kind)
				}

				require.ErrorIs(t, err, ErrDecrypt)
			})
		}
	})
}

func uuidBytes(t *testing.T, value string) []byte {
	t.Helper()

	parsed, err := uuid.Parse(value)
	require.NoError(t, err)

	return parsed[:]
}

// documentedSlotAD builds a slot's associated data from the layout in
// docs/design/crypto.md.
func documentedSlotAD(t *testing.T, vector keySlotVector) []byte {
	t.Helper()

	ad := slices.Concat([]byte("vault-sync/v1/key-slot"), uuidBytes(t, vector.VaultID))
	ad = binary.BigEndian.AppendUint64(ad, vector.Epoch)

	switch vector.RecipientKind {
	case "user":
		id := uuidBytes(t, vector.RecipientID)
		ad = append(ad, 0x01, byte(len(id)))

		return append(ad, id...)
	case "escrow":
		ad = append(ad, 0x02, byte(len(vector.RecipientID)))

		return append(ad, vector.RecipientID...)
	default:
		require.Failf(t, "unknown recipient kind", "%q", vector.RecipientKind)

		return nil
	}
}
