package e2ee

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"

	"filippo.io/age"
	"filippo.io/hpke"
)

const (
	// PrivateKeySize is the size of a hybrid private key: the 32-byte seed
	// of an MLKEM768-X25519 key pair, which is also the payload of an age
	// hybrid identity (AGE-SECRET-KEY-PQ-1…).
	PrivateKeySize = 32
	// PublicKeySize is the size of a hybrid public key: an ML-KEM-768
	// encapsulation key (1184 bytes) followed by an X25519 public key (32
	// bytes), the payload of an age hybrid recipient (age1pq1…).
	PublicKeySize = 1184 + 32
	// MaxSealedSize bounds a hybrid-sealed age file that OpenFrom accepts. A
	// key slot is at most about 2000 bytes (header 1627 bytes, payload nonce
	// 16 bytes, plaintext of at most 335 bytes and tag 16 bytes).
	MaxSealedSize = 2048

	ageRecipientHRP = "age1pq"
	ageIdentityHRP  = "age-secret-key-pq-"
)

// GenerateKeyPair returns a new hybrid ML-KEM-768 + X25519 key pair: a
// 32-byte private key (the seed) and its 1216-byte public key.
func GenerateKeyPair() (privateKey, publicKey []byte, err error) {
	key, err := hpke.MLKEM768X25519().GenerateKey()
	if err != nil {
		return nil, nil, fmt.Errorf("e2ee: %w", err)
	}

	privateKey, err = key.Bytes()
	if err != nil {
		return nil, nil, fmt.Errorf("e2ee: %w", err)
	}

	return privateKey, key.PublicKey().Bytes(), nil
}

// PublicKey returns the hybrid public key of a 32-byte private key.
func PublicKey(privateKey []byte) ([]byte, error) {
	if len(privateKey) != PrivateKeySize {
		return nil, fmt.Errorf("e2ee: private key must be %d bytes, got %d", PrivateKeySize, len(privateKey))
	}

	key, err := hpke.MLKEM768X25519().NewPrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	return key.PublicKey().Bytes(), nil
}

// AgeRecipient returns the age recipient string (age1pq1…) of a hybrid
// public key.
func AgeRecipient(publicKey []byte) (string, error) {
	if len(publicKey) != PublicKeySize {
		return "", fmt.Errorf("e2ee: public key must be %d bytes, got %d", PublicKeySize, len(publicKey))
	}

	return bech32Encode(ageRecipientHRP, publicKey), nil
}

// ParseAgeRecipient returns the hybrid public key of an age hybrid
// recipient string (age1pq1…). age validates the string first (its Bech32
// checksum, its human-readable part and its key), so only a recipient age
// itself accepts is decoded; any other string is refused.
func ParseAgeRecipient(encoded string) ([]byte, error) {
	if _, err := age.ParseHybridRecipient(encoded); err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	lower := strings.ToLower(encoded)
	separator := strings.LastIndexByte(lower, '1')
	// The data part ends with a six-character checksum.
	words := lower[separator+1 : len(lower)-6]
	publicKey := make([]byte, 0, len(words)*5/8)

	var (
		accumulator uint32
		bits        uint
	)

	for index := range len(words) {
		value := strings.IndexByte(bech32Charset, words[index])
		if value < 0 {
			return nil, fmt.Errorf("e2ee: invalid age recipient")
		}

		accumulator = accumulator<<5 | uint32(value)
		bits += 5

		if bits >= 8 {
			bits -= 8
			publicKey = append(publicKey, byte(accumulator>>bits))
		}
	}

	// age accepted it, but check the round trip rather than trust the
	// arithmetic above.
	if again, err := AgeRecipient(publicKey); err != nil || again != lower {
		return nil, fmt.Errorf("e2ee: invalid age recipient")
	}

	return publicKey, nil
}

// EscrowKeyID returns the id that names an escrow public key in escrow key
// slots (recipient_id, docs/design/crypto.md): "sha256:" followed by the
// lowercase hex SHA-256 of the 1216-byte public key. It is derived from the
// key, so a new escrow key gets a new id without any setting.
func EscrowKeyID(publicKey []byte) (string, error) {
	if len(publicKey) != PublicKeySize {
		return "", fmt.Errorf("e2ee: public key must be %d bytes, got %d", PublicKeySize, len(publicKey))
	}

	sum := sha256.Sum256(publicKey)

	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// AgeIdentity returns the age identity string (AGE-SECRET-KEY-PQ-1…) of a
// hybrid private key, which the standard age tool accepts with -i.
func AgeIdentity(privateKey []byte) (string, error) {
	if len(privateKey) != PrivateKeySize {
		return "", fmt.Errorf("e2ee: private key must be %d bytes, got %d", PrivateKeySize, len(privateKey))
	}

	return strings.ToUpper(bech32Encode(ageIdentityHRP, privateKey)), nil
}

// SealTo encrypts plaintext to a hybrid public key as a binary age file with
// a single mlkem768x25519 recipient stanza (age's hybrid post-quantum
// recipient type).
func SealTo(recipientPublicKey, plaintext []byte) ([]byte, error) {
	encoded, err := AgeRecipient(recipientPublicKey)
	if err != nil {
		return nil, err
	}

	recipient, err := age.ParseHybridRecipient(encoded)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	var out bytes.Buffer

	writer, err := age.Encrypt(&out, recipient)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	if _, err := writer.Write(plaintext); err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	return out.Bytes(), nil
}

// OpenFrom reverses SealTo with the recipient's hybrid private key. It
// returns ErrDecrypt for every input that is not a well-formed age file to
// this key of at most MaxSealedSize bytes.
func OpenFrom(recipientPrivateKey, sealed []byte) ([]byte, error) {
	encoded, err := AgeIdentity(recipientPrivateKey)
	if err != nil {
		return nil, err
	}

	identity, err := age.ParseHybridIdentity(encoded)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	if len(sealed) == 0 || len(sealed) > MaxSealedSize {
		return nil, ErrDecrypt
	}

	reader, err := age.Decrypt(bytes.NewReader(sealed), identity)
	if err != nil {
		return nil, ErrDecrypt
	}

	plaintext, err := io.ReadAll(io.LimitReader(reader, MaxSealedSize))
	if err != nil {
		return nil, ErrDecrypt
	}

	return plaintext, nil
}

const bech32Charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

// bech32Encode encodes data as Bech32 (BIP 173) under a lowercase
// human-readable part, without BIP 173's 90-character limit, as age does.
func bech32Encode(hrp string, data []byte) string {
	words := make([]byte, 0, (len(data)*8+4)/5+6)

	var (
		accumulator uint32
		bits        uint
	)

	for _, value := range data {
		accumulator = accumulator<<8 | uint32(value)
		bits += 8

		for bits >= 5 {
			bits -= 5
			words = append(words, byte(accumulator>>bits)&31)
		}
	}

	if bits > 0 {
		words = append(words, byte(accumulator<<(5-bits))&31)
	}

	values := make([]byte, 0, 2*len(hrp)+1+len(words)+6)
	for index := range len(hrp) {
		values = append(values, hrp[index]>>5)
	}

	values = append(values, 0)
	for index := range len(hrp) {
		values = append(values, hrp[index]&31)
	}

	values = append(values, words...)
	checksum := bech32Polymod(append(values, 0, 0, 0, 0, 0, 0)) ^ 1

	for index := range 6 {
		words = append(words, byte(checksum>>(5*(5-index)))&31)
	}

	var out strings.Builder

	out.WriteString(hrp)
	out.WriteByte('1')

	for _, word := range words {
		out.WriteByte(bech32Charset[word])
	}

	return out.String()
}

func bech32Polymod(values []byte) uint32 {
	generator := [5]uint32{0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3}
	checksum := uint32(1)

	for _, value := range values {
		top := checksum >> 25
		checksum = (checksum&0x1ffffff)<<5 ^ uint32(value)

		for index := range 5 {
			if (top>>index)&1 == 1 {
				checksum ^= generator[index]
			}
		}
	}

	return checksum
}
