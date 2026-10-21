// Package e2ee implements the end-to-end encryption primitives of SPEC.md §9.3
// as cipher suite 1: HKDF-SHA256 sub-keys, XChaCha20-Poly1305 with associated
// data, an X25519 sealed box for key slots, HMAC-SHA256 path_key and blob_id,
// and Argon2id passphrase wrapping.
//
// Every ciphertext starts with its suite version byte, and every open
// authenticates the whole header together with the caller's associated data,
// so a ciphertext with an unknown suite, a changed header or associated data,
// or a truncated tag fails closed with ErrDecrypt. The formats are described
// in docs/design/crypto.md; testdata/crypto/vectors.json pins them, and the
// TypeScript implementation (plugin/src/core/e2ee) must agree with it.
//
// Key management (epochs, key slots, recovery) is built on top of this
// package elsewhere.
package e2ee

import (
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"

	"github.com/solidDoWant/vault-sync/internal/pathkey"
)

const (
	// SuiteV1 is the suite version byte of every suite 1 ciphertext.
	SuiteV1 byte = 0x01

	// KeySize is the size of every symmetric key, sub-key and X25519 key.
	KeySize = 32
	// NonceSize is the XChaCha20-Poly1305 nonce size.
	NonceSize = chacha20poly1305.NonceSizeX
	// TagSize is the Poly1305 tag size.
	TagSize = chacha20poly1305.Overhead
	// SaltSize is the Argon2id salt size of a passphrase-wrapped secret.
	SaltSize = 16
	// MACSize is the size of a path_key or blob_id HMAC.
	MACSize = sha256.Size

	sealedHeaderSize     = 1 + KeySize
	passphraseHeaderSize = 1 + 4 + 4 + 1 + SaltSize
)

// ErrDecrypt is returned for every ciphertext that does not open: unknown
// suite, malformed or short input, or a failed authentication. The causes are
// deliberately not told apart.
var ErrDecrypt = errors.New("e2ee: ciphertext does not authenticate")

// Label names an HKDF sub-key of a vault epoch key (SPEC.md §9.3).
type Label string

// The sub-keys of an epoch key.
const (
	LabelContent       Label = "content"
	LabelPath          Label = "path"
	LabelPathKeySecret Label = "path_key_secret"
	LabelBlobIDSecret  Label = "blob_id_secret"
)

const (
	subkeyInfoPrefix = "vault-sync/v1/subkey/"
	sealedBoxInfo    = "vault-sync/v1/sealed-box"
)

// DeriveSubkey derives the sub-key named by label from a 32-byte epoch key:
// HKDF-SHA256 with an empty salt and the info "vault-sync/v1/subkey/" + label.
func DeriveSubkey(epochKey []byte, label Label) ([]byte, error) {
	if len(epochKey) != KeySize {
		return nil, fmt.Errorf("e2ee: epoch key must be %d bytes, got %d", KeySize, len(epochKey))
	}

	switch label {
	case LabelContent, LabelPath, LabelPathKeySecret, LabelBlobIDSecret:
	default:
		return nil, fmt.Errorf("e2ee: unknown sub-key label %q", label)
	}

	return hkdf.Key(sha256.New, epochKey, nil, subkeyInfoPrefix+string(label), KeySize)
}

// Seal encrypts plaintext under a 32-byte key with a fresh random nonce and
// binds aad: SuiteV1 || nonce || XChaCha20-Poly1305(plaintext), the
// associated data being SuiteV1 || aad.
func Seal(key, plaintext, aad []byte) ([]byte, error) {
	nonce, err := randomBytes(NonceSize)
	if err != nil {
		return nil, err
	}

	return sealWithNonce(key, nonce, plaintext, aad)
}

func sealWithNonce(key, nonce, plaintext, aad []byte) ([]byte, error) {
	header := []byte{SuiteV1}

	return sealAfterHeader(header, key, nonce, plaintext, aad)
}

// sealAfterHeader returns header || nonce || ciphertext, authenticating
// header || aad.
func sealAfterHeader(header, key, nonce, plaintext, aad []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	if len(nonce) != NonceSize {
		return nil, fmt.Errorf("e2ee: nonce must be %d bytes, got %d", NonceSize, len(nonce))
	}

	out := make([]byte, 0, len(header)+NonceSize+len(plaintext)+TagSize)
	out = append(out, header...)
	out = append(out, nonce...)

	return aead.Seal(out, nonce, plaintext, slices.Concat(header, aad)), nil
}

// Open reverses Seal. It returns ErrDecrypt unless sealed is a suite 1
// ciphertext under key with exactly this aad.
func Open(key, sealed, aad []byte) ([]byte, error) {
	if len(sealed) < 1 || sealed[0] != SuiteV1 {
		return nil, ErrDecrypt
	}

	return openAfterHeader(sealed[:1], key, sealed[1:], aad)
}

// openAfterHeader opens nonce || ciphertext, authenticating header || aad.
func openAfterHeader(header, key, rest, aad []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("e2ee: key must be %d bytes, got %d", KeySize, len(key))
	}

	if len(rest) < NonceSize+TagSize {
		return nil, ErrDecrypt
	}

	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	plaintext, err := aead.Open(nil, rest[:NonceSize], rest[NonceSize:], slices.Concat(header, aad))
	if err != nil {
		return nil, ErrDecrypt
	}

	return plaintext, nil
}

// GenerateKey returns a new random 32-byte symmetric key (an epoch key).
func GenerateKey() ([]byte, error) {
	return randomBytes(KeySize)
}

// GenerateKeyPair returns a new X25519 private key and its public key.
func GenerateKeyPair() (privateKey, publicKey []byte, err error) {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("e2ee: %w", err)
	}

	return key.Bytes(), key.PublicKey().Bytes(), nil
}

// PublicKey returns the X25519 public key of a 32-byte private key.
func PublicKey(privateKey []byte) ([]byte, error) {
	key, err := ecdh.X25519().NewPrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	return key.PublicKey().Bytes(), nil
}

// SealTo encrypts plaintext (an epoch key) to an X25519 public key, binding
// aad: SuiteV1 || ephemeral public key || nonce || ciphertext. The key is
// HKDF-SHA256 of the X25519 shared secret, salted with the ephemeral and
// recipient public keys; the associated data is the header || aad.
func SealTo(recipientPublicKey, plaintext, aad []byte) ([]byte, error) {
	ephemeral, err := randomBytes(KeySize)
	if err != nil {
		return nil, err
	}

	nonce, err := randomBytes(NonceSize)
	if err != nil {
		return nil, err
	}

	return sealToWith(recipientPublicKey, ephemeral, nonce, plaintext, aad)
}

func sealToWith(recipientPublicKey, ephemeralPrivateKey, nonce, plaintext, aad []byte) ([]byte, error) {
	ephemeral, err := ecdh.X25519().NewPrivateKey(ephemeralPrivateKey)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	recipient, err := ecdh.X25519().NewPublicKey(recipientPublicKey)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	ephemeralPublicKey := ephemeral.PublicKey().Bytes()

	key, err := sealedBoxKey(ephemeral, recipient, ephemeralPublicKey, recipient.Bytes())
	if err != nil {
		return nil, err
	}

	return sealAfterHeader(slices.Concat([]byte{SuiteV1}, ephemeralPublicKey), key, nonce, plaintext, aad)
}

// OpenFrom reverses SealTo with the recipient's X25519 private key. It
// returns ErrDecrypt unless sealed is a suite 1 sealed box to this key with
// exactly this aad.
func OpenFrom(recipientPrivateKey, sealed, aad []byte) ([]byte, error) {
	recipient, err := ecdh.X25519().NewPrivateKey(recipientPrivateKey)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	if len(sealed) < sealedHeaderSize || sealed[0] != SuiteV1 {
		return nil, ErrDecrypt
	}

	ephemeralPublicKey := sealed[1:sealedHeaderSize]

	ephemeral, err := ecdh.X25519().NewPublicKey(ephemeralPublicKey)
	if err != nil {
		return nil, ErrDecrypt
	}

	key, err := sealedBoxKey(recipient, ephemeral, ephemeralPublicKey, recipient.PublicKey().Bytes())
	if err != nil {
		return nil, ErrDecrypt
	}

	return openAfterHeader(sealed[:sealedHeaderSize], key, sealed[sealedHeaderSize:], aad)
}

func sealedBoxKey(private *ecdh.PrivateKey, public *ecdh.PublicKey, ephemeralPublicKey, recipientPublicKey []byte) ([]byte, error) {
	// ECDH refuses an all-zero shared secret, which a low-order public key
	// produces.
	shared, err := private.ECDH(public)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	return hkdf.Key(sha256.New, shared, slices.Concat(ephemeralPublicKey, recipientPublicKey), sealedBoxInfo, KeySize)
}

// PathKey returns the E2EE path_key of a path (SPEC.md §5):
// HMAC-SHA256(path_key_secret, UTF-8 of the normalized path).
func PathKey(pathKeySecret []byte, path string) ([]byte, error) {
	return mac(pathKeySecret, []byte(pathkey.Key(path)))
}

// BlobID returns the E2EE blob_id of a plaintext (SPEC.md §5):
// HMAC-SHA256(blob_id_secret, plaintext).
func BlobID(blobIDSecret, plaintext []byte) ([]byte, error) {
	return mac(blobIDSecret, plaintext)
}

func mac(secret, data []byte) ([]byte, error) {
	if len(secret) != KeySize {
		return nil, fmt.Errorf("e2ee: secret must be %d bytes, got %d", KeySize, len(secret))
	}

	h := hmac.New(sha256.New, secret)
	h.Write(data)

	return h.Sum(nil), nil
}

// Argon2Params are the Argon2id parameters of a passphrase-wrapped secret.
type Argon2Params struct {
	// Memory is the memory cost in KiB.
	Memory uint32
	// Iterations is the time cost.
	Iterations uint32
	// Parallelism is the number of lanes.
	Parallelism uint8
}

// DefaultArgon2Params are the parameters WrapWithPassphrase uses: 64 MiB,
// three passes, one lane (RFC 9106 §4's second recommendation with one lane,
// since the plugin computes in a single JavaScript thread). Measurements are
// in docs/design/crypto.md.
var DefaultArgon2Params = Argon2Params{Memory: 64 * 1024, Iterations: 3, Parallelism: 1}

// The bounds of Argon2Params a passphrase-wrapped secret may carry. The upper
// bounds keep a hostile stored value from making a phone allocate or compute
// without limit; the lower bounds refuse parameters weaker than OWASP's
// minimum for Argon2id.
const (
	MinArgon2Memory      = 19 * 1024
	MaxArgon2Memory      = 128 * 1024
	MinArgon2Iterations  = 2
	MaxArgon2Iterations  = 8
	MinArgon2Parallelism = 1
	MaxArgon2Parallelism = 4
)

func (params Argon2Params) valid() bool {
	return params.Memory >= MinArgon2Memory && params.Memory <= MaxArgon2Memory &&
		params.Iterations >= MinArgon2Iterations && params.Iterations <= MaxArgon2Iterations &&
		params.Parallelism >= MinArgon2Parallelism && params.Parallelism <= MaxArgon2Parallelism
}

// WrapWithPassphrase encrypts secret (a user's X25519 private key) under a
// key derived from passphrase with Argon2id and binds aad:
// SuiteV1 || memory (u32 BE) || iterations (u32 BE) || parallelism (u8) ||
// salt (16) || nonce || ciphertext, the associated data being the header ||
// aad. The passphrase is NFC-normalized first with the pinned Unicode tables
// of internal/pathkey (not the runtime's), so every device derives the same
// key from the same characters.
func WrapWithPassphrase(passphrase string, secret, aad []byte) ([]byte, error) {
	return WrapWithPassphraseParams(passphrase, DefaultArgon2Params, secret, aad)
}

// WrapWithPassphraseParams is WrapWithPassphrase with explicit Argon2id
// parameters, which must lie within the bounds.
func WrapWithPassphraseParams(passphrase string, params Argon2Params, secret, aad []byte) ([]byte, error) {
	salt, err := randomBytes(SaltSize)
	if err != nil {
		return nil, err
	}

	nonce, err := randomBytes(NonceSize)
	if err != nil {
		return nil, err
	}

	return wrapWith(passphrase, params, salt, nonce, secret, aad)
}

func wrapWith(passphrase string, params Argon2Params, salt, nonce, secret, aad []byte) ([]byte, error) {
	if passphrase == "" {
		return nil, errors.New("e2ee: passphrase is empty")
	}

	if !params.valid() {
		return nil, fmt.Errorf("e2ee: Argon2id parameters out of bounds: %+v", params)
	}

	if len(salt) != SaltSize {
		return nil, fmt.Errorf("e2ee: salt must be %d bytes, got %d", SaltSize, len(salt))
	}

	header := make([]byte, 0, passphraseHeaderSize)
	header = append(header, SuiteV1)
	header = binary.BigEndian.AppendUint32(header, params.Memory)
	header = binary.BigEndian.AppendUint32(header, params.Iterations)
	header = append(header, params.Parallelism)
	header = append(header, salt...)

	return sealAfterHeader(header, passphraseKey(passphrase, params, salt), nonce, secret, aad)
}

// UnwrapWithPassphrase reverses WrapWithPassphrase. It returns ErrDecrypt for
// a wrong passphrase, a different aad, an unknown suite, a changed header or
// Argon2id parameters outside the bounds, which it refuses before deriving.
func UnwrapWithPassphrase(passphrase string, wrapped, aad []byte) ([]byte, error) {
	// Refuse what cannot open before paying for the derivation.
	if len(wrapped) < passphraseHeaderSize+NonceSize+TagSize || wrapped[0] != SuiteV1 {
		return nil, ErrDecrypt
	}

	params := Argon2Params{
		Memory:      binary.BigEndian.Uint32(wrapped[1:5]),
		Iterations:  binary.BigEndian.Uint32(wrapped[5:9]),
		Parallelism: wrapped[9],
	}
	if !params.valid() {
		return nil, ErrDecrypt
	}

	salt := wrapped[10:passphraseHeaderSize]

	return openAfterHeader(wrapped[:passphraseHeaderSize], passphraseKey(passphrase, params, salt), wrapped[passphraseHeaderSize:], aad)
}

func passphraseKey(passphrase string, params Argon2Params, salt []byte) []byte {
	return argon2.IDKey([]byte(pathkey.NFC(passphrase)), salt, params.Iterations, params.Memory, params.Parallelism, KeySize)
}

func randomBytes(size int) ([]byte, error) {
	out := make([]byte, size)
	if _, err := rand.Read(out); err != nil {
		return nil, fmt.Errorf("e2ee: reading random bytes: %w", err)
	}

	return out, nil
}
