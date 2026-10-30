package api

import (
	"bytes"
	"fmt"
	"math"
	"slices"

	"connectrpc.com/connect"

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

// signedEpoch is a new epoch's record and the membership log entries
// appended with it (a RotateEpoch's escrow entries or a RemoveMember's
// remove-member entry), bounds-checked.
type signedEpoch struct {
	vaultID       uuid.UUID
	record        *vaultsyncv1.EpochRecord
	escrowEntries []store.LogEntry
	// offStateReset is true when escrowEntries are an escrow reset entry of
	// a vault with escrow off followed by the escrow "on" entry.
	offStateReset bool
	// position is the seq of the entry appended with the epoch, which the
	// record must name as its log position; 0 when there is none.
	position uint64
	// replay is what the log is replayed with: the deployment's escrow chain.
	replay e2ee.ReplayOptions
}

// parseSignedEpoch checks the bounds of a RotateEpoch's record and escrow
// entries, and that an escrow "on" or escrow reset entry names the escrow
// chain's head (ESCROW_NOT_CURRENT otherwise); whether they verify is
// decided under the vault row lock (check). resetEntry is the escrow reset
// entry sent before escrowEntry in a vault with escrow off, or nil.
func parseSignedEpoch(vaultID uuid.UUID, record *vaultsyncv1.EpochRecord, escrowEntry, resetEntry *vaultsyncv1.LogEntry, escrow Escrow) (signedEpoch, error) {
	if len(record.GetRecipients()) > MaxEpochRecordRecipients {
		return signedEpoch{}, invalidArgument("record.recipients must hold at most %d recipients", MaxEpochRecordRecipients)
	}

	signed := signedEpoch{vaultID: vaultID, record: record, replay: escrow.replayOptions()}

	if resetEntry != nil {
		if escrowEntry == nil || escrowEntry.GetType() != uint32(e2ee.EntryEscrow) {
			return signedEpoch{}, invalidArgument("escrow_reset_entry needs an escrow on entry (type %d) as escrow_entry", e2ee.EntryEscrow)
		}

		entry, err := parseEscrowEntry("escrow_reset_entry", resetEntry, escrow, e2ee.EntryEscrowReset)
		if err != nil {
			return signedEpoch{}, err
		}

		signed.escrowEntries = append(signed.escrowEntries, entry)
		signed.offStateReset = true
	}

	if escrowEntry != nil {
		entry, err := parseEscrowEntry("escrow_entry", escrowEntry, escrow, e2ee.EntryEscrow, e2ee.EntryEscrowReset)
		if err != nil {
			return signedEpoch{}, err
		}

		if signed.offStateReset && escrowedBundle(entry) == nil {
			return signedEpoch{}, invalidArgument("escrow_entry must turn escrow on after an escrow_reset_entry")
		}

		signed.escrowEntries = append(signed.escrowEntries, entry)
		signed.position = escrowEntry.GetSeq()
	}

	return signed, nil
}

// parseEscrowEntry checks the bounds of an escrow entry of one of types,
// and refuses one that names an escrow bundle other than the escrow chain's
// head with ESCROW_NOT_CURRENT.
func parseEscrowEntry(field string, message *vaultsyncv1.LogEntry, escrow Escrow, types ...e2ee.EntryType) (store.LogEntry, error) {
	if message.GetType() > math.MaxUint8 || !slices.Contains(types, e2ee.EntryType(message.GetType())) {
		return store.LogEntry{}, invalidArgument("%s must be an entry of type %v", field, types)
	}

	if message.GetSeq() == 0 || message.GetSeq() > math.MaxInt64 {
		return store.LogEntry{}, invalidArgument("%s.seq is out of range", field)
	}

	entry := store.LogEntry{
		Seq:        int64(message.GetSeq()), //nolint:gosec // checked against MaxInt64 above.
		PrevHash:   message.GetPrevHash(),
		Type:       byte(message.GetType()),
		Payload:    message.GetPayload(),
		Signatures: message.GetSignatures(),
	}

	// A malformed bundle is left to the log replay, which refuses it.
	if named := escrowedBundle(entry); named != nil && (escrow.Bundle == nil || !escrowBundlesEqual(*named, *escrow.Bundle)) {
		return store.LogEntry{}, escrowNotCurrent(field)
	}

	return entry, nil
}

// escrowedBundle returns the escrow bundle an escrow "on" or escrow reset
// entry names, or nil for any other entry or a malformed one.
func escrowedBundle(entry store.LogEntry) *e2ee.EscrowBundle {
	var encoded []byte

	switch {
	case entry.Type == byte(e2ee.EntryEscrow) && len(entry.Payload) > 1 && entry.Payload[0] == 0x01:
		encoded = entry.Payload[1:]
	case entry.Type == byte(e2ee.EntryEscrowReset) && len(entry.Payload) > e2ee.HashSize:
		encoded = entry.Payload[e2ee.HashSize:]
	default:
		return nil
	}

	bundle, err := e2ee.ParseEscrowBundle(encoded)
	if err != nil {
		return nil
	}

	return &bundle
}

func escrowBundlesEqual(left, right e2ee.EscrowBundle) bool {
	return bytes.Equal(left.SignPub, right.SignPub) && left.Recipient == right.Recipient
}

// escrowNotCurrent is the refusal of a request naming an escrow bundle that
// is not the escrow chain's head.
func escrowNotCurrent(field string) error {
	return ReasonError(connect.CodeFailedPrecondition, vaultsyncv1.ErrorReason_ERROR_REASON_ESCROW_NOT_CURRENT,
		fmt.Errorf("%s names an escrow key that is not the escrow chain's head; re-read GetServerInfo", field))
}

// parseRemovalEpoch checks the bounds of a RemoveMember's record; entry is
// the remove-member entry (nil in a plaintext vault), the record's log
// position. The store runs the check once entry is in the log.
func parseRemovalEpoch(vaultID uuid.UUID, record *vaultsyncv1.EpochRecord, entry *store.LogAppend, escrow Escrow) (signedEpoch, error) {
	signed, err := parseSignedEpoch(vaultID, record, nil, nil, escrow)
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

		states, err := e2ee.ReplayLog(signed.vaultID.String(), entries, signed.replay)
		if err != nil {
			return false, refuseEpoch("the membership log does not verify with the entry appended with the epoch")
		}

		if signed.position != 0 && signed.record.GetLogSeq() != signed.position {
			return false, refuseEpoch("the record's log position must be the entry appended with the epoch")
		}

		if err := signed.checkEscrowEntries(states); err != nil {
			return false, err
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

// checkEscrowEntries refuses an escrow reset entry that does not fit the
// vault's escrow state: sent on its own, it carries a rotation and needs
// escrow on; sent before an escrow "on" entry, it needs escrow off.
// states is the replayed log ending with the escrow entries.
func (signed signedEpoch) checkEscrowEntries(states []e2ee.LogState) error {
	if len(signed.escrowEntries) == 0 {
		return nil
	}

	reset := signed.escrowEntries[0]
	if reset.Type != byte(e2ee.EntryEscrowReset) {
		return nil
	}

	before := len(states) - len(signed.escrowEntries) - 1
	if before < 0 {
		return refuseEpoch("an escrow reset entry needs a log before it")
	}

	escrowOn := states[before].Escrow != nil
	if signed.offStateReset && escrowOn {
		return refuseEpoch("escrow_reset_entry is only for a vault with escrow off; send the escrow reset entry as escrow_entry")
	}

	if !signed.offStateReset && !escrowOn {
		return refuseEpoch("an escrow reset entry of a vault with escrow off must come before the escrow on entry")
	}

	return nil
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
