package e2ee

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"
)

// The identity keys of docs/design/crypto.md "Identity keys, the membership
// log and signed epochs": a user's secret holds the seeds of a hybrid key
// pair and an Ed25519 signing key, and a bundle publishes both public keys.

const (
	// UserSecretSize is the size of a user secret: kem_seed (32) || sign_seed (32).
	UserSecretSize = PrivateKeySize + ed25519.SeedSize
	// SignPublicKeySize is the size of an Ed25519 public key.
	SignPublicKeySize = ed25519.PublicKeySize
	// SignatureSize is the size of an Ed25519 signature.
	SignatureSize = ed25519.SignatureSize
	// FingerprintSize is the size of a bundle fingerprint.
	FingerprintSize = sha256.Size
	// HashSize is the size of a log entry hash and a genesis hash.
	HashSize = sha256.Size

	bundleLabel         = "vault-sync/v1/bundle"
	fingerprintLabel    = "vault-sync/v1/fingerprint"
	inviteSignLabel     = "vault-sync/v1/invitation-sign"
	inviteAnchorLabel   = "vault-sync/v1/invite-anchor"
	invitationKeyLabel  = "vault-sync/v1/invitation-key"
	anchorsLabel        = "vault-sync/v1/anchors"
	escrowBundleLabel   = "vault-sync/v1/escrow"
	escrowRotationLabel = "vault-sync/v1/escrow-rotation"

	// BundleSize is the size of an encoded user key bundle.
	BundleSize = len(bundleLabel) + 16 + SignPublicKeySize + PublicKeySize

	// MaxEscrowRecipientSize bounds the age recipient string of an escrow
	// bundle (a hybrid recipient is about 1960 characters).
	MaxEscrowRecipientSize = 4096
	// MaxAnchors bounds the number of vaults in an anchor list.
	MaxAnchors = 100_000
	// MaxSealedAnchorListSize is the size of a sealed anchor list of
	// MaxAnchors vaults: the suite byte, the nonce, the count, each vault id
	// with its genesis hash, and the tag.
	MaxSealedAnchorListSize = 1 + NonceSize + 4 + MaxAnchors*(16+HashSize) + TagSize

	fingerprintDisplayBytes = 20
	inviteSecretSize        = 16
)

// ErrSignature is returned for every signed statement that does not verify.
var ErrSignature = errors.New("e2ee: signature does not verify")

var crockford = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

// UserSecret is a user's 64-byte secret, the value the passphrase wraps.
type UserSecret struct {
	KEMSeed  []byte
	SignSeed []byte
}

// GenerateUserSecret returns a new random user secret.
func GenerateUserSecret() (UserSecret, error) {
	raw, err := randomBytes(UserSecretSize)
	if err != nil {
		return UserSecret{}, err
	}

	return ParseUserSecret(raw)
}

// ParseUserSecret splits the 64 bytes kem_seed || sign_seed.
func ParseUserSecret(raw []byte) (UserSecret, error) {
	if len(raw) != UserSecretSize {
		return UserSecret{}, fmt.Errorf("e2ee: user secret must be %d bytes, got %d", UserSecretSize, len(raw))
	}

	return UserSecret{
		KEMSeed:  slices.Clone(raw[:PrivateKeySize]),
		SignSeed: slices.Clone(raw[PrivateKeySize:]),
	}, nil
}

// Bytes returns kem_seed || sign_seed.
func (secret UserSecret) Bytes() []byte {
	return slices.Concat(secret.KEMSeed, secret.SignSeed)
}

// SignKey returns the Ed25519 private key of the secret.
func (secret UserSecret) SignKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(secret.SignSeed)
}

// Bundle returns the user key bundle of the secret for userID.
func (secret UserSecret) Bundle(userID string) (Bundle, error) {
	kemPub, err := PublicKey(secret.KEMSeed)
	if err != nil {
		return Bundle{}, err
	}

	signPub, ok := secret.SignKey().Public().(ed25519.PublicKey)
	if !ok {
		return Bundle{}, errors.New("e2ee: unexpected signing public key type")
	}

	return Bundle{UserID: userID, SignPub: slices.Clone(signPub), KEMPub: kemPub}, nil
}

// Bundle is a user key bundle: (user id, signing public key, hybrid public key).
type Bundle struct {
	UserID  string
	SignPub []byte
	KEMPub  []byte
}

// Encode returns "vault-sync/v1/bundle" || uuid(user_id) || sign_pub (32) || kem_pub (1216).
func (bundle Bundle) Encode() ([]byte, error) {
	userID, err := canonicalUUID(bundle.UserID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: bundle user id: %w", err)
	}

	if len(bundle.SignPub) != SignPublicKeySize || len(bundle.KEMPub) != PublicKeySize {
		return nil, errors.New("e2ee: bundle key of the wrong size")
	}

	return slices.Concat([]byte(bundleLabel), userID, bundle.SignPub, bundle.KEMPub), nil
}

// ParseBundle reverses Bundle.Encode.
func ParseBundle(encoded []byte) (Bundle, error) {
	if len(encoded) != BundleSize || !bytes.HasPrefix(encoded, []byte(bundleLabel)) {
		return Bundle{}, errors.New("e2ee: malformed bundle")
	}

	rest := encoded[len(bundleLabel):]

	userID, err := uuidString(rest[:16])
	if err != nil {
		return Bundle{}, err
	}

	return Bundle{
		UserID:  userID,
		SignPub: slices.Clone(rest[16 : 16+SignPublicKeySize]),
		KEMPub:  slices.Clone(rest[16+SignPublicKeySize:]),
	}, nil
}

// Fingerprint returns SHA-256("vault-sync/v1/fingerprint" || sign_pub || kem_pub).
func (bundle Bundle) Fingerprint() []byte {
	sum := sha256.Sum256(slices.Concat([]byte(fingerprintLabel), bundle.SignPub, bundle.KEMPub))

	return sum[:]
}

// FormatFingerprint returns the first 20 bytes of a fingerprint in Crockford
// base32, in groups of four characters separated by spaces.
func FormatFingerprint(fingerprint []byte) string {
	encoded := crockford.EncodeToString(fingerprint[:min(len(fingerprint), fingerprintDisplayBytes)])

	groups := make([]string, 0, (len(encoded)+3)/4)
	for start := 0; start < len(encoded); start += 4 {
		groups = append(groups, encoded[start:min(start+4, len(encoded))])
	}

	return strings.Join(groups, " ")
}

// inviteKey derives a 32-byte key from the 16-byte invitation secret:
// HKDF-SHA256(secret, salt = uuid(vault_id), info = label || uuid(invitation_id)).
func inviteKey(secret []byte, vaultID, invitationID, label string) ([]byte, error) {
	if len(secret) != inviteSecretSize {
		return nil, fmt.Errorf("e2ee: invitation secret must be %d bytes, got %d", inviteSecretSize, len(secret))
	}

	vault, err := canonicalUUID(vaultID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: vault id: %w", err)
	}

	invitation, err := canonicalUUID(invitationID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: invitation id: %w", err)
	}

	key, err := hkdf.Key(sha256.New, secret, vault, label+string(invitation), KeySize)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	return key, nil
}

// InviteSignSeed derives the Ed25519 seed of an invitation's signing key
// from the 16-byte invitation secret.
func InviteSignSeed(secret []byte, vaultID, invitationID string) ([]byte, error) {
	return inviteKey(secret, vaultID, invitationID, inviteSignLabel)
}

// InviteMACKey derives the key that authenticates an invitation's anchor
// from the 16-byte invitation secret.
func InviteMACKey(secret []byte, vaultID, invitationID string) ([]byte, error) {
	return inviteKey(secret, vaultID, invitationID, inviteAnchorLabel)
}

// InvitationKeyPair derives an invitation's hybrid key pair from the
// 16-byte invitation secret: the private key is the seed
// HKDF-SHA256(secret, salt = uuid(vault_id), info =
// "vault-sync/v1/invitation-key" || uuid(invitation_id)), and the public key
// is the one the library derives from that seed. Epoch keys are sealed to the
// public key in invitation key slots until the invitation is redeemed.
func InvitationKeyPair(secret []byte, vaultID, invitationID string) (privateKey, publicKey []byte, err error) {
	privateKey, err = inviteKey(secret, vaultID, invitationID, invitationKeyLabel)
	if err != nil {
		return nil, nil, err
	}

	publicKey, err = PublicKey(privateKey)
	if err != nil {
		return nil, nil, err
	}

	return privateKey, publicKey, nil
}

// InviteAnchorSize is the size of an invite anchor: genesis hash, inviter
// fingerprint and their MAC.
const InviteAnchorSize = HashSize + FingerprintSize + MACSize

// InviteAnchor is what an inviting device gives an invitation: the vault's
// genesis hash and the inviter's fingerprint.
type InviteAnchor struct {
	GenesisHash        []byte
	InviterFingerprint []byte
}

func inviteAnchorMAC(macKey []byte, vaultID, invitationID string, genesisHash, inviterFingerprint []byte) ([]byte, error) {
	vault, err := canonicalUUID(vaultID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: vault id: %w", err)
	}

	invitation, err := canonicalUUID(invitationID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: invitation id: %w", err)
	}

	return mac(macKey, slices.Concat([]byte(inviteAnchorLabel), vault, invitation, genesisHash, inviterFingerprint))
}

// MakeInviteAnchor returns genesis_hash (32) || inviter_fingerprint (32) ||
// HMAC-SHA256(invite_mac_key, "vault-sync/v1/invite-anchor" || uuid(vault_id) ||
// uuid(invitation_id) || genesis_hash || inviter_fingerprint).
func MakeInviteAnchor(secret []byte, vaultID, invitationID string, anchor InviteAnchor) ([]byte, error) {
	if len(anchor.GenesisHash) != HashSize || len(anchor.InviterFingerprint) != FingerprintSize {
		return nil, errors.New("e2ee: invite anchor hash of the wrong size")
	}

	macKey, err := InviteMACKey(secret, vaultID, invitationID)
	if err != nil {
		return nil, err
	}

	tag, err := inviteAnchorMAC(macKey, vaultID, invitationID, anchor.GenesisHash, anchor.InviterFingerprint)
	if err != nil {
		return nil, err
	}

	return slices.Concat(anchor.GenesisHash, anchor.InviterFingerprint, tag), nil
}

// VerifyInviteAnchor checks an invite anchor of vaultID and invitationID
// against the invitation secret, comparing the MAC in constant time, and
// returns what it holds. It fails with ErrSignature for any other vault,
// invitation, secret or a changed or malformed anchor.
func VerifyInviteAnchor(secret []byte, vaultID, invitationID string, encoded []byte) (InviteAnchor, error) {
	if len(encoded) != InviteAnchorSize {
		return InviteAnchor{}, ErrSignature
	}

	macKey, err := InviteMACKey(secret, vaultID, invitationID)
	if err != nil {
		return InviteAnchor{}, err
	}

	genesisHash, inviterFingerprint := encoded[:HashSize], encoded[HashSize:HashSize+FingerprintSize]

	expected, err := inviteAnchorMAC(macKey, vaultID, invitationID, genesisHash, inviterFingerprint)
	if err != nil {
		return InviteAnchor{}, err
	}

	if !hmac.Equal(expected, encoded[HashSize+FingerprintSize:]) {
		return InviteAnchor{}, ErrSignature
	}

	return InviteAnchor{GenesisHash: slices.Clone(genesisHash), InviterFingerprint: slices.Clone(inviterFingerprint)}, nil
}

// Anchor is one entry of an anchor list: a vault and its genesis hash.
type Anchor struct {
	VaultID     string
	GenesisHash []byte
}

// AnchorKey derives the key of a user's anchor list from the user's kem_seed.
func AnchorKey(kemSeed []byte) ([]byte, error) {
	if len(kemSeed) != PrivateKeySize {
		return nil, fmt.Errorf("e2ee: kem seed must be %d bytes, got %d", PrivateKeySize, len(kemSeed))
	}

	key, err := hkdf.Key(sha256.New, kemSeed, nil, anchorsLabel, KeySize)
	if err != nil {
		return nil, fmt.Errorf("e2ee: %w", err)
	}

	return key, nil
}

func anchorListAD(userID string, version uint64) ([]byte, error) {
	user, err := canonicalUUID(userID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: user id: %w", err)
	}

	return binary.BigEndian.AppendUint64(slices.Concat([]byte(anchorsLabel), user), version), nil
}

func encodeAnchors(anchors []Anchor) ([]byte, error) {
	if len(anchors) > MaxAnchors {
		return nil, errors.New("e2ee: too many anchors")
	}

	out := binary.BigEndian.AppendUint32(nil, uint32(len(anchors))) //nolint:gosec // bounded by MaxAnchors.

	for _, anchor := range anchors {
		vault, err := canonicalUUID(anchor.VaultID)
		if err != nil {
			return nil, fmt.Errorf("e2ee: anchor vault id: %w", err)
		}

		if len(anchor.GenesisHash) != HashSize {
			return nil, errors.New("e2ee: anchor genesis hash of the wrong size")
		}

		out = slices.Concat(out, vault, anchor.GenesisHash)
	}

	return out, nil
}

// SealAnchorList seals a user's anchor list at version under anchorKey.
func SealAnchorList(anchorKey []byte, userID string, version uint64, anchors []Anchor) ([]byte, error) {
	nonce, err := randomBytes(NonceSize)
	if err != nil {
		return nil, err
	}

	return sealAnchorListWithNonce(anchorKey, nonce, userID, version, anchors)
}

// sealAnchorListWithNonce is SealAnchorList with a given nonce, for vectors.
func sealAnchorListWithNonce(anchorKey, nonce []byte, userID string, version uint64, anchors []Anchor) ([]byte, error) {
	list, err := encodeAnchors(anchors)
	if err != nil {
		return nil, err
	}

	ad, err := anchorListAD(userID, version)
	if err != nil {
		return nil, err
	}

	return sealWithNonce(anchorKey, nonce, list, ad)
}

// OpenAnchorList opens a user's anchor list sealed at version. It fails with
// ErrDecrypt for another key, user or version, or a malformed list.
func OpenAnchorList(anchorKey, sealed []byte, userID string, version uint64) ([]Anchor, error) {
	ad, err := anchorListAD(userID, version)
	if err != nil {
		return nil, err
	}

	list, err := Open(anchorKey, sealed, ad)
	if err != nil {
		return nil, err
	}

	if len(list) < 4 {
		return nil, ErrDecrypt
	}

	count := binary.BigEndian.Uint32(list)
	if count > MaxAnchors || uint64(len(list)-4) != uint64(count)*(16+HashSize) {
		return nil, ErrDecrypt
	}

	anchors := make([]Anchor, 0, count)

	for rest := list[4:]; len(rest) > 0; rest = rest[16+HashSize:] {
		vault, err := uuidString(rest[:16])
		if err != nil {
			return nil, ErrDecrypt
		}

		anchors = append(anchors, Anchor{VaultID: vault, GenesisHash: slices.Clone(rest[16 : 16+HashSize])})
	}

	return anchors, nil
}

// EscrowBundle is the deployment escrow key: its Ed25519 signing public key
// and its age recipient string.
type EscrowBundle struct {
	SignPub   []byte
	Recipient string
}

// Encode returns "vault-sync/v1/escrow" || escrow_sign_pub (32) || lp(age_recipient_string).
func (bundle EscrowBundle) Encode() ([]byte, error) {
	if len(bundle.SignPub) != SignPublicKeySize {
		return nil, errors.New("e2ee: escrow signing key of the wrong size")
	}

	if len(bundle.Recipient) == 0 || len(bundle.Recipient) > MaxEscrowRecipientSize {
		return nil, errors.New("e2ee: escrow recipient of the wrong size")
	}

	return slices.Concat([]byte(escrowBundleLabel), bundle.SignPub, lengthPrefixed([]byte(bundle.Recipient))), nil
}

// ParseEscrowBundle reverses EscrowBundle.Encode; the whole input must be
// one bundle.
func ParseEscrowBundle(encoded []byte) (EscrowBundle, error) {
	bundle, rest, err := readEscrowBundle(encoded)
	if err != nil {
		return EscrowBundle{}, err
	}

	if len(rest) != 0 {
		return EscrowBundle{}, errors.New("e2ee: trailing bytes after escrow bundle")
	}

	return bundle, nil
}

func readEscrowBundle(encoded []byte) (EscrowBundle, []byte, error) {
	malformed := errors.New("e2ee: malformed escrow bundle")

	if !bytes.HasPrefix(encoded, []byte(escrowBundleLabel)) {
		return EscrowBundle{}, nil, malformed
	}

	rest := encoded[len(escrowBundleLabel):]
	if len(rest) < SignPublicKeySize {
		return EscrowBundle{}, nil, malformed
	}

	signPub := slices.Clone(rest[:SignPublicKeySize])

	recipient, rest, ok := readLengthPrefixed(rest[SignPublicKeySize:], MaxEscrowRecipientSize)
	if !ok || len(recipient) == 0 {
		return EscrowBundle{}, nil, malformed
	}

	return EscrowBundle{SignPub: signPub, Recipient: string(recipient)}, rest, nil
}

// EscrowRotation is a statement, signed by the old escrow signing key, that
// the escrow key moves from the bundle hashed in OldBundleHash to NewBundle.
type EscrowRotation struct {
	OldBundleHash []byte
	NewBundle     EscrowBundle
	Signature     []byte
}

func escrowRotationMessage(oldBundleHash []byte, newBundle EscrowBundle) ([]byte, error) {
	encoded, err := newBundle.Encode()
	if err != nil {
		return nil, err
	}

	return slices.Concat([]byte(escrowRotationLabel), oldBundleHash, encoded), nil
}

// SignEscrowRotation returns the statement moving from oldBundle to
// newBundle, signed by oldSignKey (the old escrow signing key).
func SignEscrowRotation(oldSignKey ed25519.PrivateKey, oldBundle, newBundle EscrowBundle) (EscrowRotation, error) {
	oldEncoded, err := oldBundle.Encode()
	if err != nil {
		return EscrowRotation{}, err
	}

	oldHash := sha256.Sum256(oldEncoded)

	message, err := escrowRotationMessage(oldHash[:], newBundle)
	if err != nil {
		return EscrowRotation{}, err
	}

	return EscrowRotation{OldBundleHash: oldHash[:], NewBundle: newBundle, Signature: ed25519.Sign(oldSignKey, message)}, nil
}

// VerifyEscrowChain follows rotation statements from the pinned escrow
// bundle and returns the bundle the chain ends at. Every statement must name
// the hash of the bundle before it and be signed by that bundle's signing
// key; otherwise it fails with ErrSignature.
func VerifyEscrowChain(pinned EscrowBundle, rotations []EscrowRotation) (EscrowBundle, error) {
	current := pinned

	for _, rotation := range rotations {
		encoded, err := current.Encode()
		if err != nil {
			return EscrowBundle{}, err
		}

		hash := sha256.Sum256(encoded)
		if !bytes.Equal(hash[:], rotation.OldBundleHash) {
			return EscrowBundle{}, ErrSignature
		}

		message, err := escrowRotationMessage(rotation.OldBundleHash, rotation.NewBundle)
		if err != nil {
			return EscrowBundle{}, ErrSignature
		}

		if !verifySignature(current.SignPub, message, rotation.Signature) {
			return EscrowBundle{}, ErrSignature
		}

		current = rotation.NewBundle
	}

	return current, nil
}

func verifySignature(publicKey, message, signature []byte) bool {
	return len(publicKey) == SignPublicKeySize && len(signature) == SignatureSize &&
		ed25519.Verify(publicKey, message, signature)
}

func lengthPrefixed(value []byte) []byte {
	return append(binary.BigEndian.AppendUint32(nil, uint32(len(value))), value...) //nolint:gosec // callers bound value.
}

// readLengthPrefixed reads lp(x) of at most limit bytes and returns x and the rest.
func readLengthPrefixed(encoded []byte, limit int) (value, rest []byte, ok bool) {
	if len(encoded) < 4 {
		return nil, nil, false
	}

	size := binary.BigEndian.Uint32(encoded)
	if uint64(size) > uint64(limit) || uint64(size) > uint64(len(encoded)-4) {
		return nil, nil, false
	}

	return encoded[4 : 4+size], encoded[4+size:], true
}

func uuidString(raw []byte) (string, error) {
	if len(raw) != 16 {
		return "", errors.New("e2ee: uuid must be 16 bytes")
	}

	var id uuid.UUID

	copy(id[:], raw)

	return id.String(), nil
}
