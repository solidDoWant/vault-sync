package api

import (
	"fmt"
	"math"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Signed epoch records of E2EE vaults (docs/design/encryption.md, "Signed
// epochs"; docs/design/crypto.md, epoch_body).

const (
	// MaxEpochRecordRecipients bounds the recipients of one epoch record:
	// every member, every pending invitation and the escrow key.
	MaxEpochRecordRecipients = MaxMembersPerVault + MaxPendingInvitationsPerVault + 1

	// Epoch recipient kind bytes (docs/design/crypto.md).
	epochRecipientUser       = 0x01
	epochRecipientEscrow     = 0x02
	epochRecipientInvitation = 0x03
)

// signedEpoch is a new epoch's record and the membership log entry
// appended with it (a RotateEpoch's escrow entry or a RemoveMember's
// remove-member entry), bounds-checked.
type signedEpoch struct {
	vaultID     uuid.UUID
	record      *vaultsyncv1.EpochRecord
	escrowEntry *store.LogEntry
	// position is the seq of the entry appended with the epoch, which the
	// record must name as its log position; 0 when there is none.
	position uint64
}

// parseSignedEpoch checks the bounds of a RotateEpoch's record and escrow
// entry; whether they verify is decided under the vault row lock (check).
func parseSignedEpoch(vaultID uuid.UUID, record *vaultsyncv1.EpochRecord, escrowEntry *vaultsyncv1.LogEntry) (signedEpoch, error) {
	if len(record.GetRecipients()) > MaxEpochRecordRecipients {
		return signedEpoch{}, invalidArgument("record.recipients must hold at most %d recipients", MaxEpochRecordRecipients)
	}

	signed := signedEpoch{vaultID: vaultID, record: record}

	if escrowEntry != nil {
		if escrowEntry.GetType() != uint32(e2ee.EntryEscrow) {
			return signedEpoch{}, invalidArgument("escrow_entry must be an escrow on/off entry (type %d)", e2ee.EntryEscrow)
		}

		if escrowEntry.GetSeq() == 0 || escrowEntry.GetSeq() > math.MaxInt64 {
			return signedEpoch{}, invalidArgument("escrow_entry.seq is out of range")
		}

		signed.escrowEntry = &store.LogEntry{
			Seq:        int64(escrowEntry.GetSeq()), //nolint:gosec // checked against MaxInt64 above.
			PrevHash:   escrowEntry.GetPrevHash(),
			Type:       byte(e2ee.EntryEscrow),
			Payload:    escrowEntry.GetPayload(),
			Signatures: escrowEntry.GetSignatures(),
		}
		signed.position = escrowEntry.GetSeq()
	}

	return signed, nil
}

// parseRemovalEpoch checks the bounds of a RemoveMember's record; entry is
// the remove-member entry (nil in a plaintext vault), the record's log
// position. The store runs the check once entry is in the log.
func parseRemovalEpoch(vaultID uuid.UUID, record *vaultsyncv1.EpochRecord, entry *store.LogAppend) (signedEpoch, error) {
	signed, err := parseSignedEpoch(vaultID, record, nil)
	if err != nil {
		return signedEpoch{}, err
	}

	if entry != nil {
		signed.position = uint64(max(entry.Entry.Seq, 0))
	}

	return signed, nil
}

func refuseEpoch(reason string) error {
	return fmt.Errorf("%w: %s", store.ErrEpochRecord, reason)
}

// check returns the store.EpochCheck of next: the log must replay, the
// entry appended with the epoch (if any) must be the position the record
// names, the record
// must verify there (e2ee.VerifyEpochRecord, signed over next's epoch and
// commitment and the current epoch's commitment), and next's user and
// escrow slots must be exactly the record's user and escrow recipients.
func (signed signedEpoch) check(next store.NextEpoch) store.EpochCheck {
	return func(log []store.LogEntry, prevCommitment []byte) (bool, error) {
		if signed.record == nil {
			return false, refuseEpoch("an end-to-end encrypted vault's epoch needs its signed record")
		}

		entries := make([]e2ee.Entry, len(log))
		for index, entry := range log {
			entries[index] = e2ee.Entry{
				VaultID:    signed.vaultID.String(),
				Seq:        uint64(max(entry.Seq, 0)),
				PrevHash:   entry.PrevHash,
				Type:       e2ee.EntryType(entry.Type),
				Payload:    entry.Payload,
				Signatures: entry.Signatures,
			}
		}

		states, err := e2ee.ReplayLog(signed.vaultID.String(), entries, e2ee.ReplayOptions{})
		if err != nil {
			return false, refuseEpoch("the membership log does not verify with the entry appended with the epoch")
		}

		if signed.position != 0 && signed.record.GetLogSeq() != signed.position {
			return false, refuseEpoch("the record's log position must be the entry appended with the epoch")
		}

		if prevCommitment == nil {
			prevCommitment = make([]byte, e2ee.MACSize)
		}

		recipients := make([]e2ee.EpochRecipient, len(signed.record.GetRecipients()))
		for index, recipient := range signed.record.GetRecipients() {
			if recipient.GetKind() > math.MaxUint8 {
				return false, refuseEpoch("unknown recipient kind")
			}

			recipients[index] = e2ee.EpochRecipient{
				Kind: byte(recipient.GetKind()), ID: recipient.GetRecipientId(), KeyHash: recipient.GetKeyHash(),
			}
		}

		record := e2ee.EpochRecord{
			VaultID:        signed.vaultID.String(),
			Epoch:          uint64(max(next.ExpectedEpoch, 0)) + 1,
			Commitment:     next.Commitment,
			PrevCommitment: prevCommitment,
			LogSeq:         signed.record.GetLogSeq(),
			LogHash:        signed.record.GetLogHash(),
			Recipients:     recipients,
			Signature:      signed.record.GetSignature(),
		}

		if err := e2ee.VerifyEpochRecord(record.VaultID, states, record); err != nil {
			return false, refuseEpoch("the record is not signed by an owner at its log position over this epoch, or its recipients are not the log's")
		}

		if err := slotsMatchRecipients(next.Slots, recipients); err != nil {
			return false, err
		}

		return states[record.LogSeq-1].Escrow != nil, nil
	}
}

// slotsMatchRecipients refuses slots that are not exactly one per user,
// invitation and escrow recipient of the record.
func slotsMatchRecipients(slots []store.KeySlot, recipients []e2ee.EpochRecipient) error {
	type recipientKey struct {
		kind store.RecipientKind
		id   string
	}

	expected := make(map[recipientKey]bool, len(recipients))

	for _, recipient := range recipients {
		switch recipient.Kind {
		case epochRecipientUser:
			userID, err := uuid.FromBytes(recipient.ID)
			if err != nil {
				return refuseEpoch("malformed user recipient")
			}

			expected[recipientKey{store.RecipientUser, userID.String()}] = true
		case epochRecipientInvitation:
			invitationID, err := uuid.FromBytes(recipient.ID)
			if err != nil {
				return refuseEpoch("malformed invitation recipient")
			}

			expected[recipientKey{store.RecipientInvitation, invitationID.String()}] = true
		case epochRecipientEscrow:
			expected[recipientKey{store.RecipientEscrow, string(recipient.ID)}] = true
		}
	}

	if len(slots) != len(expected) {
		return refuseEpoch("next_epoch.slots are not the record's recipients")
	}

	for _, slot := range slots {
		if !expected[recipientKey{slot.RecipientKind, slot.RecipientID}] {
			return refuseEpoch("next_epoch.slots are not the record's recipients")
		}
	}

	return nil
}

// encodeEpochRecord returns the stored form of a record (its protobuf
// encoding), or nil for none.
func encodeEpochRecord(record *vaultsyncv1.EpochRecord) ([]byte, error) {
	if record == nil {
		return nil, nil
	}

	encoded, err := proto.Marshal(record)
	if err != nil {
		return nil, fmt.Errorf("encode epoch record: %w", err)
	}

	return encoded, nil
}

// decodeEpochRecord returns the record of a stored epoch, or nil for none.
func decodeEpochRecord(encoded []byte) *vaultsyncv1.EpochRecord {
	if encoded == nil {
		return nil
	}

	record := &vaultsyncv1.EpochRecord{}
	if err := proto.Unmarshal(encoded, record); err != nil {
		return nil
	}

	return record
}
