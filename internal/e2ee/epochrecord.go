package e2ee

import (
	"bytes"
	"cmp"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
)

// Signed epoch records of docs/design/crypto.md "Identity keys, the
// membership log and signed epochs".

const (
	epochRecordLabel = "vault-sync/v1/epoch"

	// MaxEpochRecipients bounds the recipients of one epoch record (count is a u16).
	MaxEpochRecipients = 0xFFFF
)

// ErrEpochRecord is returned for an epoch record that does not verify.
var ErrEpochRecord = errors.New("e2ee: epoch record does not verify")

// EpochRecipient is one recipient of an epoch: its kind byte (0x01 user,
// 0x02 escrow, 0x03 invitation), its encoded recipient id and the SHA-256 of
// its public key.
type EpochRecipient struct {
	Kind    byte
	ID      []byte
	KeyHash []byte
}

func compareRecipients(left, right EpochRecipient) int {
	return cmp.Or(cmp.Compare(left.Kind, right.Kind), bytes.Compare(left.ID, right.ID))
}

// EpochRecord is a signed epoch.
type EpochRecord struct {
	VaultID        string
	Epoch          uint64
	Commitment     []byte
	PrevCommitment []byte
	LogSeq         uint64
	LogHash        []byte
	Recipients     []EpochRecipient
	Signature      []byte
}

// Body returns the signed bytes:
//
//	"vault-sync/v1/epoch" || uuid(vault_id) || epoch (u64) || commitment (32) || prev_commitment (32)
//	|| log_seq (u64) || log_hash (32) || count (u16) || recipients
//
// with each recipient kind (u8) || lp(recipient_id) || key hash (32), in the
// record's order.
func (record EpochRecord) Body() ([]byte, error) {
	vault, err := canonicalUUID(record.VaultID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: vault id: %w", err)
	}

	if len(record.Commitment) != MACSize || len(record.PrevCommitment) != MACSize || len(record.LogHash) != HashSize {
		return nil, errors.New("e2ee: epoch record hash of the wrong size")
	}

	if len(record.Recipients) > MaxEpochRecipients {
		return nil, errors.New("e2ee: too many epoch recipients")
	}

	body := binary.BigEndian.AppendUint64(slices.Concat([]byte(epochRecordLabel), vault), record.Epoch)
	body = slices.Concat(body, record.Commitment, record.PrevCommitment)
	body = binary.BigEndian.AppendUint64(body, record.LogSeq)
	body = append(body, record.LogHash...)
	body = binary.BigEndian.AppendUint16(body, uint16(len(record.Recipients))) //nolint:gosec // bounded above.

	for _, recipient := range record.Recipients {
		if len(recipient.ID) == 0 || len(recipient.ID) > MaxRecipientIDSize || len(recipient.KeyHash) != HashSize {
			return nil, errors.New("e2ee: malformed epoch recipient")
		}

		body = append(body, recipient.Kind)
		body = append(body, lengthPrefixed(recipient.ID)...)
		body = append(body, recipient.KeyHash...)
	}

	return body, nil
}

// Sign returns the record signed by an owner's signing key.
func (record EpochRecord) Sign(ownerSignKey ed25519.PrivateKey) (EpochRecord, error) {
	body, err := record.Body()
	if err != nil {
		return EpochRecord{}, err
	}

	record.Signature = ed25519.Sign(ownerSignKey, body)

	return record, nil
}

// EpochRecipients returns the sorted recipients an epoch at state must list:
// every member, every pending invitation and the escrow key if escrow is on,
// each with the hash of its public key from the log.
func EpochRecipients(state LogState) ([]EpochRecipient, error) {
	recipients := make([]EpochRecipient, 0, len(state.Members)+len(state.Invitations)+1)

	for userID, member := range state.Members {
		id, err := canonicalUUID(userID)
		if err != nil {
			return nil, err
		}

		recipients = append(recipients, EpochRecipient{Kind: recipientKindUserByte, ID: id, KeyHash: keyHash(member.Bundle.KEMPub)})
	}

	for invitationID, invitation := range state.Invitations {
		id, err := canonicalUUID(invitationID)
		if err != nil {
			return nil, err
		}

		recipients = append(recipients, EpochRecipient{Kind: recipientKindInvitationByte, ID: id, KeyHash: keyHash(invitation.KEMPub)})
	}

	if state.Escrow != nil {
		publicKey, err := ParseAgeRecipient(state.Escrow.Recipient)
		if err != nil {
			return nil, err
		}

		escrowID, err := EscrowKeyID(publicKey)
		if err != nil {
			return nil, err
		}

		recipients = append(recipients, EpochRecipient{
			Kind: recipientKindEscrowByte, ID: []byte(escrowID), KeyHash: keyHash([]byte(state.Escrow.Recipient)),
		})
	}

	slices.SortFunc(recipients, compareRecipients)

	return recipients, nil
}

func keyHash(publicKey []byte) []byte {
	sum := sha256.Sum256(publicKey)

	return sum[:]
}

// VerifyEpochRecord checks a record against the replayed log states
// (ReplayLog's result): the log position it names exists with that hash,
// an owner at that position signed it, its recipients are exactly
// EpochRecipients at that position in sorted order, and epoch 1 has an
// all-zero previous commitment. It fails with ErrEpochRecord.
func VerifyEpochRecord(vaultID string, states []LogState, record EpochRecord) error {
	if record.VaultID != vaultID || record.Epoch == 0 || record.LogSeq == 0 || record.LogSeq > uint64(len(states)) {
		return ErrEpochRecord
	}

	state := states[record.LogSeq-1]
	if !bytes.Equal(state.Hash, record.LogHash) {
		return ErrEpochRecord
	}

	if record.Epoch == 1 && !bytes.Equal(record.PrevCommitment, make([]byte, MACSize)) {
		return ErrEpochRecord
	}

	body, err := record.Body()
	if err != nil {
		return ErrEpochRecord
	}

	if !state.ownerSigned(body, record.Signature) {
		return ErrEpochRecord
	}

	expected, err := EpochRecipients(state)
	if err != nil {
		return ErrEpochRecord
	}

	if !slices.EqualFunc(expected, record.Recipients, func(left, right EpochRecipient) bool {
		return left.Kind == right.Kind && bytes.Equal(left.ID, right.ID) && bytes.Equal(left.KeyHash, right.KeyHash)
	}) {
		return ErrEpochRecord
	}

	return nil
}

// VerifyEpochPositions checks the log positions the verified records of
// epochs 1 to N name (logSeqs[i] is epoch i+1's) against the replayed log
// states: positions never go backwards, so a removed or demoted owner cannot
// sign a new epoch at a position from before the change, and the current
// epoch's position is at or after the log's last remove-member entry. A
// vault without an epoch yet passes. It fails with ErrEpochRecord.
func VerifyEpochPositions(states []LogState, logSeqs []uint64) error {
	if len(logSeqs) == 0 {
		return nil
	}

	if len(states) == 0 {
		return ErrEpochRecord
	}

	for index := 1; index < len(logSeqs); index++ {
		if logSeqs[index] < logSeqs[index-1] {
			return ErrEpochRecord
		}
	}

	if logSeqs[len(logSeqs)-1] < states[len(states)-1].lastRemoval {
		return ErrEpochRecord
	}

	return nil
}
