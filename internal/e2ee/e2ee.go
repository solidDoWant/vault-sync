// Package e2ee implements the end-to-end encryption primitives of SPEC.md §9.3
// as cipher suite 2: HKDF-SHA256 sub-keys, XChaCha20-Poly1305 with associated
// data, hybrid post-quantum (ML-KEM-768 + X25519) key wrapping in age's
// format for key slots (hybrid.go), HMAC-SHA256 path_key and blob_id, and
// Argon2id passphrase wrapping.
//
// Every symmetric ciphertext starts with its suite version byte, and every open
// authenticates the whole header together with the caller's associated data,
// so a ciphertext with an unknown suite, a changed header or associated data,
// or a truncated tag fails closed with ErrDecrypt. The formats are described
// in docs/design/crypto.md; testdata/crypto/vectors.json pins them, and the
// TypeScript implementation (plugin/src/core/e2ee) must agree with it.
//
// The key slots and key commitments of vault key epochs are in keyslot.go;
// the rest of key management (storing epochs and slots, rotation, recovery)
// is built on top of this package elsewhere.
package e2ee

import (
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
	// SuiteV2 is the suite version byte of every suite 2 symmetric
	// ciphertext and passphrase-wrapped secret.
	SuiteV2 byte = 0x02

	// KeySize is the size of every symmetric key and sub-key.
	KeySize = 32
	// NonceSize is the XChaCha20-Poly1305 nonce size.
	NonceSize = chacha20poly1305.NonceSizeX
	// TagSize is the Poly1305 tag size.
	TagSize = chacha20poly1305.Overhead
	// SaltSize is the Argon2id salt size of a passphrase-wrapped secret.
	SaltSize = 16
	// MACSize is the size of a path_key or blob_id HMAC.
	MACSize = sha256.Size

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
// binds aad: SuiteV2 || nonce || XChaCha20-Poly1305(plaintext), the
// associated data being SuiteV2 || aad.
func Seal(key, plaintext, aad []byte) ([]byte, error) {
	nonce, err := randomBytes(NonceSize)
	if err != nil {
		return nil, err
	}

	return sealWithNonce(key, nonce, plaintext, aad)
}

func sealWithNonce(key, nonce, plaintext, aad []byte) ([]byte, error) {
	header := []byte{SuiteV2}

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

// Open reverses Seal. It returns ErrDecrypt unless sealed is a suite 2
// ciphertext under key with exactly this aad.
func Open(key, sealed, aad []byte) ([]byte, error) {
	if len(sealed) < 1 || sealed[0] != SuiteV2 {
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

// PassphraseKeys are the two keys derived from a passphrase (SPEC.md §9.3).
// WrapKey encrypts the wrapped secret and never leaves the device; AuthKey is
// the verifier the device presents to the server to have the wrapped secret
// released. Both are HKDF-SHA256 expansions of the same Argon2id output under
// different info labels, so neither can be computed from the other: the
// server, which learns AuthKey, cannot unwrap the secret with it.
type PassphraseKeys struct {
	WrapKey []byte
	AuthKey []byte
}

const (
	passphraseWrapInfo = "vault-sync/v1/passphrase/wrap"
	passphraseAuthInfo = "vault-sync/v1/passphrase/auth"
)

// ErrUnassignedPassphrase is returned when a passphrase is set or used with a
// code point not assigned in Unicode 15.0.
var ErrUnassignedPassphrase = errors.New("e2ee: a passphrase may only use characters assigned in Unicode 15.0")

// DerivePassphraseKeys derives the wrap and auth keys of passphrase:
// stretched = Argon2id(UTF-8(NFC(passphrase)), salt, params, 32), then
// HKDF-SHA256(stretched, empty salt, info) with the info
// "vault-sync/v1/passphrase/wrap" and "vault-sync/v1/passphrase/auth". The
// passphrase may only use code points assigned in Unicode 15.0
// (pathkey.Assigned), whose normalization Unicode keeps stable, and is
// NFC-normalized with pathkey.NFC, as the TypeScript client does, so every
// device derives the same keys from the same characters. It refuses an empty
// passphrase, ErrUnassignedPassphrase, a salt of the wrong size and
// parameters outside the bounds before deriving.
func DerivePassphraseKeys(passphrase string, params Argon2Params, salt []byte) (PassphraseKeys, error) {
	if passphrase == "" {
		return PassphraseKeys{}, errors.New("e2ee: passphrase is empty")
	}

	if !pathkey.Assigned(passphrase) {
		return PassphraseKeys{}, ErrUnassignedPassphrase
	}

	if !params.valid() {
		return PassphraseKeys{}, fmt.Errorf("e2ee: Argon2id parameters out of bounds: %+v", params)
	}

	if len(salt) != SaltSize {
		return PassphraseKeys{}, fmt.Errorf("e2ee: salt must be %d bytes, got %d", SaltSize, len(salt))
	}

	stretched := argon2.IDKey([]byte(pathkey.NFC(passphrase)), salt, params.Iterations, params.Memory, params.Parallelism, KeySize)

	wrapKey, err := hkdf.Key(sha256.New, stretched, nil, passphraseWrapInfo, KeySize)
	if err != nil {
		return PassphraseKeys{}, fmt.Errorf("e2ee: %w", err)
	}

	authKey, err := hkdf.Key(sha256.New, stretched, nil, passphraseAuthInfo, KeySize)
	if err != nil {
		return PassphraseKeys{}, fmt.Errorf("e2ee: %w", err)
	}

	return PassphraseKeys{WrapKey: wrapKey, AuthKey: authKey}, nil
}

// WrapWithPassphrase encrypts secret (a user's hybrid private key) under the
// wrap key of passphrase (DerivePassphraseKeys) with a fresh salt and binds
// aad: SuiteV2 || memory (u32 BE) || iterations (u32 BE) || parallelism (u8)
// || salt (16) || nonce || ciphertext, the associated data being the header
// || aad. It also returns the auth key, for the server's verifier.
func WrapWithPassphrase(passphrase string, secret, aad []byte) (wrapped, authKey []byte, err error) {
	return WrapWithPassphraseParams(passphrase, DefaultArgon2Params, secret, aad)
}

// WrapWithPassphraseParams is WrapWithPassphrase with explicit Argon2id
// parameters, which must lie within the bounds.
func WrapWithPassphraseParams(passphrase string, params Argon2Params, secret, aad []byte) (wrapped, authKey []byte, err error) {
	salt, err := randomBytes(SaltSize)
	if err != nil {
		return nil, nil, err
	}

	nonce, err := randomBytes(NonceSize)
	if err != nil {
		return nil, nil, err
	}

	wrapped, keys, err := wrapWith(passphrase, params, salt, nonce, secret, aad)
	if err != nil {
		return nil, nil, err
	}

	return wrapped, keys.AuthKey, nil
}

func wrapWith(passphrase string, params Argon2Params, salt, nonce, secret, aad []byte) ([]byte, PassphraseKeys, error) {
	keys, err := DerivePassphraseKeys(passphrase, params, salt)
	if err != nil {
		return nil, PassphraseKeys{}, err
	}

	header := make([]byte, 0, passphraseHeaderSize)
	header = append(header, SuiteV2)
	header = binary.BigEndian.AppendUint32(header, params.Memory)
	header = binary.BigEndian.AppendUint32(header, params.Iterations)
	header = append(header, params.Parallelism)
	header = append(header, salt...)

	wrapped, err := sealAfterHeader(header, keys.WrapKey, nonce, secret, aad)
	if err != nil {
		return nil, PassphraseKeys{}, err
	}

	return wrapped, keys, nil
}

// ParsePassphraseHeader returns the Argon2id parameters and salt from the
// header of a passphrase-wrapped secret (at least its first 26 bytes), so a
// device can derive its keys before it holds the wrapped secret. It returns
// ErrDecrypt for an unknown suite, a short header or parameters outside the
// bounds.
func ParsePassphraseHeader(wrapped []byte) (Argon2Params, []byte, error) {
	if len(wrapped) < passphraseHeaderSize || wrapped[0] != SuiteV2 {
		return Argon2Params{}, nil, ErrDecrypt
	}

	params := Argon2Params{
		Memory:      binary.BigEndian.Uint32(wrapped[1:5]),
		Iterations:  binary.BigEndian.Uint32(wrapped[5:9]),
		Parallelism: wrapped[9],
	}
	if !params.valid() {
		return Argon2Params{}, nil, ErrDecrypt
	}

	return params, slices.Clone(wrapped[10:passphraseHeaderSize]), nil
}

// UnwrapWithPassphrase reverses WrapWithPassphrase. It returns ErrDecrypt for
// a wrong passphrase, a different aad, an unknown suite, a changed header or
// Argon2id parameters outside the bounds, which it refuses before deriving.
func UnwrapWithPassphrase(passphrase string, wrapped, aad []byte) ([]byte, error) {
	// Refuse what cannot open before paying for the derivation.
	if len(wrapped) < passphraseHeaderSize+NonceSize+TagSize {
		return nil, ErrDecrypt
	}

	params, salt, err := ParsePassphraseHeader(wrapped)
	if err != nil {
		return nil, err
	}

	keys, err := DerivePassphraseKeys(passphrase, params, salt)
	if err != nil {
		return nil, ErrDecrypt
	}

	return UnwrapWithKey(keys.WrapKey, wrapped, aad)
}

// UnwrapWithKey opens a passphrase-wrapped secret with a wrap key already
// derived by DerivePassphraseKeys from its header's parameters and salt. It
// returns ErrDecrypt as UnwrapWithPassphrase does.
func UnwrapWithKey(wrapKey, wrapped, aad []byte) ([]byte, error) {
	if _, _, err := ParsePassphraseHeader(wrapped); err != nil {
		return nil, err
	}

	return openAfterHeader(wrapped[:passphraseHeaderSize], wrapKey, wrapped[passphraseHeaderSize:], aad)
}

func randomBytes(size int) ([]byte, error) {
	out := make([]byte, size)
	if _, err := rand.Read(out); err != nil {
		return nil, fmt.Errorf("e2ee: reading random bytes: %w", err)
	}

	return out, nil
}
