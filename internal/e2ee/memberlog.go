package e2ee

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"maps"
	"slices"
)

// The membership log of docs/design/crypto.md "Identity keys, the membership
// log and signed epochs": an append-only, hash-chained, signed log per
// encrypted vault, and the replay that turns it into the member set.

const (
	logEntryLabel = "vault-sync/v1/log-entry"

	// MaxEntryPayloadSize bounds the payload of a log entry. The largest is a
	// genesis with an escrow bundle.
	MaxEntryPayloadSize = BundleSize + 1 + len(escrowBundleLabel) + SignPublicKeySize + 4 + MaxEscrowRecipientSize
)

// ErrLog is returned when a membership log does not verify: a broken link, a
// wrong signer or an entry that is not allowed at its point in the log.
var ErrLog = errors.New("e2ee: membership log does not verify")

// EntryType is the type byte of a log entry.
type EntryType byte

// The entry types.
const (
	EntryGenesis          EntryType = 0x01
	EntryInvite           EntryType = 0x02
	EntryRevokeInvitation EntryType = 0x03
	EntryRedeem           EntryType = 0x04
	EntryRemoveMember     EntryType = 0x05
	EntryLeave            EntryType = 0x06
	EntrySetRole          EntryType = 0x07
	EntryEscrow           EntryType = 0x08
)

// Role is a member's or an invitation's role.
type Role byte

// The roles.
const (
	RoleOwner  Role = 0x01
	RoleEditor Role = 0x02
	RoleViewer Role = 0x03
)

func (role Role) valid() bool { return role >= RoleOwner && role <= RoleViewer }

// Entry is one log entry with its signatures. A redeem entry has two, the
// invitation key's first and the newcomer's second; every other entry has one.
type Entry struct {
	VaultID    string
	Seq        uint64
	PrevHash   []byte
	Type       EntryType
	Payload    []byte
	Signatures [][]byte
}

// Body returns the signed bytes:
//
//	"vault-sync/v1/log-entry" || uuid(vault_id) || seq (u64) || prev_hash (32) || type (u8) || lp(payload)
func (entry Entry) Body() ([]byte, error) {
	vault, err := canonicalUUID(entry.VaultID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: vault id: %w", err)
	}

	if len(entry.PrevHash) != HashSize {
		return nil, errors.New("e2ee: prev hash of the wrong size")
	}

	if len(entry.Payload) > MaxEntryPayloadSize {
		return nil, errors.New("e2ee: log entry payload too large")
	}

	body := binary.BigEndian.AppendUint64(slices.Concat([]byte(logEntryLabel), vault), entry.Seq)
	body = append(body, entry.PrevHash...)
	body = append(body, byte(entry.Type))

	return append(body, lengthPrefixed(entry.Payload)...), nil
}

// Hash returns SHA-256 of the entry body.
func (entry Entry) Hash() ([]byte, error) {
	body, err := entry.Body()
	if err != nil {
		return nil, err
	}

	sum := sha256.Sum256(body)

	return sum[:], nil
}

// Sign returns the entry signed by keys, in order.
func (entry Entry) Sign(keys ...ed25519.PrivateKey) (Entry, error) {
	body, err := entry.Body()
	if err != nil {
		return Entry{}, err
	}

	entry.Signatures = make([][]byte, 0, len(keys))
	for _, key := range keys {
		entry.Signatures = append(entry.Signatures, ed25519.Sign(key, body))
	}

	return entry, nil
}

// GenesisPayload returns the creator's bundle, then 0x00, or 0x01 and the escrow bundle.
func GenesisPayload(creator Bundle, escrow *EscrowBundle) ([]byte, error) {
	bundle, err := creator.Encode()
	if err != nil {
		return nil, err
	}

	escrowPart, err := EscrowPayload(escrow)
	if err != nil {
		return nil, err
	}

	return slices.Concat(bundle, escrowPart), nil
}

// InvitePayload returns uuid(invitation_id) || role || invite_sign_pub.
func InvitePayload(invitationID string, role Role, inviteSignPub []byte) ([]byte, error) {
	invitation, err := canonicalUUID(invitationID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: invitation id: %w", err)
	}

	if !role.valid() || len(inviteSignPub) != SignPublicKeySize {
		return nil, errors.New("e2ee: malformed invite")
	}

	return slices.Concat(invitation, []byte{byte(role)}, inviteSignPub), nil
}

// IDPayload returns uuid(id), the payload of revoke invitation, remove member and leave.
func IDPayload(id string) ([]byte, error) {
	return canonicalUUID(id)
}

// RedeemPayload returns uuid(invitation_id) || newcomer bundle.
func RedeemPayload(invitationID string, newcomer Bundle) ([]byte, error) {
	invitation, err := canonicalUUID(invitationID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: invitation id: %w", err)
	}

	bundle, err := newcomer.Encode()
	if err != nil {
		return nil, err
	}

	return slices.Concat(invitation, bundle), nil
}

// SetRolePayload returns uuid(user_id) || role.
func SetRolePayload(userID string, role Role) ([]byte, error) {
	user, err := canonicalUUID(userID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: user id: %w", err)
	}

	if !role.valid() {
		return nil, errors.New("e2ee: unknown role")
	}

	return append(user, byte(role)), nil
}

// EscrowPayload returns 0x00 for no escrow, or 0x01 || escrow bundle.
func EscrowPayload(escrow *EscrowBundle) ([]byte, error) {
	if escrow == nil {
		return []byte{0x00}, nil
	}

	encoded, err := escrow.Encode()
	if err != nil {
		return nil, err
	}

	return append([]byte{0x01}, encoded...), nil
}

func parseEscrowPayload(payload []byte) (*EscrowBundle, bool) {
	switch {
	case len(payload) == 1 && payload[0] == 0x00:
		return nil, true
	case len(payload) > 1 && payload[0] == 0x01:
		bundle, err := ParseEscrowBundle(payload[1:])
		if err != nil {
			return nil, false
		}

		return &bundle, true
	default:
		return nil, false
	}
}

// Member is a vault member in the replayed log.
type Member struct {
	Bundle Bundle
	Role   Role
}

// Invitation is a pending invitation in the replayed log.
type Invitation struct {
	ID      string
	Role    Role
	SignPub []byte
}

// LogState is the membership after the entry at Seq.
type LogState struct {
	Seq         uint64
	Hash        []byte
	Members     map[string]Member
	Invitations map[string]Invitation
	Escrow      *EscrowBundle

	// lastEscrow is the escrow bundle most recently named in the log, kept
	// while escrow is off so that turning it back on must chain from it.
	lastEscrow *EscrowBundle
}

func (state LogState) clone() LogState {
	state.Members = maps.Clone(state.Members)
	state.Invitations = maps.Clone(state.Invitations)

	return state
}

func (state LogState) ownerSigned(body, signature []byte) bool {
	for _, member := range state.Members {
		if member.Role == RoleOwner && verifySignature(member.Bundle.SignPub, body, signature) {
			return true
		}
	}

	return false
}

func (state LogState) hasOwner() bool {
	for _, member := range state.Members {
		if member.Role == RoleOwner {
			return true
		}
	}

	return false
}

// ReplayOptions are what a device trusts beyond the log.
type ReplayOptions struct {
	// GenesisHash, if set, is the trust anchor the genesis entry must hash to.
	GenesisHash []byte
	// EscrowRotations is the published chain of escrow rotation statements;
	// an escrow entry may move the vault only to a bundle this chain reaches
	// from the vault's previous escrow bundle.
	EscrowRotations []EscrowRotation
}

// ReplayLog verifies a vault's log from genesis and returns the state after
// every entry (states[i] is the state at seq i+1). It fails with ErrLog on
// the first broken link, wrong signer or entry not allowed at its point.
func ReplayLog(vaultID string, entries []Entry, options ReplayOptions) ([]LogState, error) {
	if len(entries) == 0 {
		return nil, fmt.Errorf("%w: empty log", ErrLog)
	}

	states := make([]LogState, 0, len(entries))
	used := map[string]bool{}
	state := LogState{Hash: make([]byte, HashSize)}

	for index, entry := range entries {
		next, err := applyEntry(vaultID, state, used, entry, options)
		if err != nil {
			return nil, fmt.Errorf("%w: seq %d: %w", ErrLog, index+1, err)
		}

		if index == 0 && options.GenesisHash != nil && !bytes.Equal(next.Hash, options.GenesisHash) {
			return nil, fmt.Errorf("%w: genesis does not match the trust anchor", ErrLog)
		}

		states = append(states, next)
		state = next
	}

	return states, nil
}

func applyEntry(vaultID string, state LogState, used map[string]bool, entry Entry, options ReplayOptions) (LogState, error) {
	if entry.VaultID != vaultID || entry.Seq != state.Seq+1 || !bytes.Equal(entry.PrevHash, state.Hash) {
		return LogState{}, errors.New("broken link")
	}

	body, err := entry.Body()
	if err != nil {
		return LogState{}, err
	}

	if (entry.Type == EntryGenesis) != (entry.Seq == 1) {
		return LogState{}, errors.New("genesis must be exactly the first entry")
	}

	wantSignatures := 1
	if entry.Type == EntryRedeem {
		wantSignatures = 2
	}

	if len(entry.Signatures) != wantSignatures {
		return LogState{}, errors.New("wrong number of signatures")
	}

	next := state.clone()
	if next.Members == nil {
		next.Members = map[string]Member{}
		next.Invitations = map[string]Invitation{}
	}

	payload := entry.Payload
	signature := entry.Signatures[0]

	switch entry.Type {
	case EntryGenesis:
		if len(payload) < BundleSize {
			return LogState{}, errors.New("malformed genesis")
		}

		creator, err := ParseBundle(payload[:BundleSize])
		if err != nil {
			return LogState{}, err
		}

		escrow, ok := parseEscrowPayload(payload[BundleSize:])
		if !ok {
			return LogState{}, errors.New("malformed genesis escrow")
		}

		if !verifySignature(creator.SignPub, body, signature) {
			return LogState{}, errors.New("wrong signer")
		}

		next.Members[creator.UserID] = Member{Bundle: creator, Role: RoleOwner}
		next.Escrow, next.lastEscrow = escrow, escrow
	case EntryInvite:
		if len(payload) != 16+1+SignPublicKeySize {
			return LogState{}, errors.New("malformed invite")
		}

		id, err := uuidString(payload[:16])
		if err != nil {
			return LogState{}, err
		}

		role := Role(payload[16])
		if !role.valid() {
			return LogState{}, errors.New("unknown role")
		}

		if !state.ownerSigned(body, signature) {
			return LogState{}, errors.New("wrong signer")
		}

		if used[id] {
			return LogState{}, errors.New("invitation id already used")
		}

		used[id] = true
		next.Invitations[id] = Invitation{ID: id, Role: role, SignPub: slices.Clone(payload[17:])}
	case EntryRevokeInvitation:
		id, err := uuidString(payload)
		if err != nil {
			return LogState{}, err
		}

		if !state.ownerSigned(body, signature) {
			return LogState{}, errors.New("wrong signer")
		}

		if _, ok := state.Invitations[id]; !ok {
			return LogState{}, errors.New("invitation not pending")
		}

		delete(next.Invitations, id)
	case EntryRedeem:
		if len(payload) != 16+BundleSize {
			return LogState{}, errors.New("malformed redeem")
		}

		id, err := uuidString(payload[:16])
		if err != nil {
			return LogState{}, err
		}

		newcomer, err := ParseBundle(payload[16:])
		if err != nil {
			return LogState{}, err
		}

		invitation, ok := state.Invitations[id]
		if !ok {
			return LogState{}, errors.New("invitation not pending")
		}

		if !verifySignature(invitation.SignPub, body, signature) ||
			!verifySignature(newcomer.SignPub, body, entry.Signatures[1]) {
			return LogState{}, errors.New("wrong signer")
		}

		if _, ok := state.Members[newcomer.UserID]; ok {
			return LogState{}, errors.New("already a member")
		}

		delete(next.Invitations, id)
		next.Members[newcomer.UserID] = Member{Bundle: newcomer, Role: invitation.Role}
	case EntryRemoveMember, EntryLeave:
		user, err := uuidString(payload)
		if err != nil {
			return LogState{}, err
		}

		member, ok := state.Members[user]
		if !ok {
			return LogState{}, errors.New("not a member")
		}

		signed := state.ownerSigned(body, signature)
		if entry.Type == EntryLeave {
			signed = verifySignature(member.Bundle.SignPub, body, signature)
		}

		if !signed {
			return LogState{}, errors.New("wrong signer")
		}

		delete(next.Members, user)
	case EntrySetRole:
		if len(payload) != 17 {
			return LogState{}, errors.New("malformed set role")
		}

		user, err := uuidString(payload[:16])
		if err != nil {
			return LogState{}, err
		}

		role := Role(payload[16])
		if !role.valid() {
			return LogState{}, errors.New("unknown role")
		}

		member, ok := state.Members[user]
		if !ok {
			return LogState{}, errors.New("not a member")
		}

		if !state.ownerSigned(body, signature) {
			return LogState{}, errors.New("wrong signer")
		}

		member.Role = role
		next.Members[user] = member
	case EntryEscrow:
		escrow, ok := parseEscrowPayload(payload)
		if !ok {
			return LogState{}, errors.New("malformed escrow")
		}

		if !state.ownerSigned(body, signature) {
			return LogState{}, errors.New("wrong signer")
		}

		if escrow != nil && state.lastEscrow != nil {
			if err := escrowReachable(*state.lastEscrow, *escrow, options.EscrowRotations); err != nil {
				return LogState{}, err
			}
		}

		next.Escrow = escrow
		if escrow != nil {
			next.lastEscrow = escrow
		}
	default:
		return LogState{}, errors.New("unknown entry type")
	}

	if !next.hasOwner() {
		return LogState{}, errors.New("no owner left")
	}

	hash := sha256.Sum256(body)
	next.Seq = entry.Seq
	next.Hash = hash[:]

	return next, nil
}

// escrowReachable reports whether target is from itself or a bundle the
// published rotation chain reaches from it, each step signed by the key it
// replaces. Statements before from's position in the chain are skipped.
func escrowReachable(from, target EscrowBundle, rotations []EscrowRotation) error {
	current := from

	for _, rotation := range rotations {
		if escrowEqual(current, target) {
			return nil
		}

		encoded, err := current.Encode()
		if err != nil {
			return err
		}

		hash := sha256.Sum256(encoded)
		if !bytes.Equal(hash[:], rotation.OldBundleHash) {
			continue
		}

		next, err := VerifyEscrowChain(current, []EscrowRotation{rotation})
		if err != nil {
			return errors.New("unsigned escrow rotation")
		}

		current = next
	}

	if escrowEqual(current, target) {
		return nil
	}

	return errors.New("unchained escrow key")
}

func escrowEqual(left, right EscrowBundle) bool {
	return bytes.Equal(left.SignPub, right.SignPub) && left.Recipient == right.Recipient
}
