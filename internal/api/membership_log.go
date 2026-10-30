package api

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"math"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Membership changes of E2EE vaults carry their signed log entry
// (docs/design/encryption.md, "Protection against an active server"). The
// store appends it under the vault row lock after the verifier built here
// replays it onto the stored log and checks that it records exactly the
// requested change.

// errLogEntryRefused is returned by a log entry's verifier: the entry does
// not verify on top of the stored log, or records another change than the
// request.
var errLogEntryRefused = errors.New("log_entry does not verify on the vault's log or does not record the requested change")

// parseLogEntry bounds a request's log entry and converts it.
func parseLogEntry(message *vaultsyncv1.LogEntry) (store.LogEntry, error) {
	refused := connect.NewError(connect.CodeInvalidArgument, errLogEntryRefused)

	if message.GetType() > math.MaxUint8 || message.GetSeq() < 1 || message.GetSeq() > math.MaxInt64 ||
		len(message.GetPrevHash()) != e2ee.HashSize || len(message.GetPayload()) > e2ee.MaxEntryPayloadSize ||
		len(message.GetSignatures()) < 1 || len(message.GetSignatures()) > 2 {
		return store.LogEntry{}, refused
	}

	for _, signature := range message.GetSignatures() {
		if len(signature) != ed25519.SignatureSize {
			return store.LogEntry{}, refused
		}
	}

	return store.LogEntry{
		Seq:        int64(message.GetSeq()), //nolint:gosec // checked against MaxInt64 above.
		PrevHash:   message.GetPrevHash(),
		Type:       byte(message.GetType()),
		Payload:    message.GetPayload(),
		Signatures: message.GetSignatures(),
	}, nil
}

func e2eeEntry(vaultID uuid.UUID, entry store.LogEntry) e2ee.Entry {
	return e2ee.Entry{
		VaultID:    vaultID.String(),
		Seq:        uint64(max(entry.Seq, 0)),
		PrevHash:   entry.PrevHash,
		Type:       e2ee.EntryType(entry.Type),
		Payload:    entry.Payload,
		Signatures: entry.Signatures,
	}
}

// logAppend returns the store append of a membership change's log entry, or
// nil when the request carries none (the store decides whether the vault
// needs one). records reports whether the entry records the requested
// change; invitationID is the invitation being redeemed, uuid.Nil otherwise.
// replay carries the deployment's escrow chain.
func logAppend(message *vaultsyncv1.LogEntry, records func(entry store.LogEntry, invitationID uuid.UUID) bool, replay e2ee.ReplayOptions) (*store.LogAppend, error) {
	if message == nil {
		return nil, nil
	}

	entry, err := parseLogEntry(message)
	if err != nil {
		return nil, err
	}

	return &store.LogAppend{
		Entry: entry,
		Verify: func(vaultID, invitationID uuid.UUID, log []store.LogEntry) error {
			if !records(entry, invitationID) {
				return errLogEntryRefused
			}

			entries := make([]e2ee.Entry, 0, len(log)+1)
			for _, stored := range log {
				entries = append(entries, e2eeEntry(vaultID, stored))
			}

			_, err := e2ee.ReplayLog(vaultID.String(), append(entries, e2eeEntry(vaultID, entry)), replay)
			if err != nil {
				return errLogEntryRefused
			}

			return nil
		},
	}, nil
}

// records returns a check that an entry has the given type and payload.
func records(entryType e2ee.EntryType, payload []byte) func(store.LogEntry, uuid.UUID) bool {
	return func(entry store.LogEntry, _ uuid.UUID) bool {
		return entry.Type == byte(entryType) && bytes.Equal(entry.Payload, payload)
	}
}

// logRole is a role's byte in the log.
func logRole(role store.Role) e2ee.Role {
	switch role {
	case store.RoleOwner:
		return e2ee.RoleOwner
	case store.RoleEditor:
		return e2ee.RoleEditor
	default:
		return e2ee.RoleViewer
	}
}

// inviteEntryID returns the invitation id an invite entry names, or
// uuid.Nil without an entry. The invitation is stored under this id.
func inviteEntryID(message *vaultsyncv1.LogEntry) (uuid.UUID, error) {
	if message == nil {
		return uuid.Nil, nil
	}

	id, err := uuid.FromBytes(message.GetPayload()[:min(16, len(message.GetPayload()))])
	if err != nil || id == uuid.Nil {
		return uuid.Nil, connect.NewError(connect.CodeInvalidArgument, errLogEntryRefused)
	}

	return id, nil
}

// recordsInvite checks an invite entry for invitation id with role.
func recordsInvite(id uuid.UUID, role store.Role) func(store.LogEntry, uuid.UUID) bool {
	return func(entry store.LogEntry, _ uuid.UUID) bool {
		return entry.Type == byte(e2ee.EntryInvite) && len(entry.Payload) > 16 &&
			bytes.Equal(entry.Payload[:16], id[:]) && entry.Payload[16] == byte(logRole(role))
	}
}

// recordsRedeem checks a redeem entry of the redeemed invitation whose
// newcomer is the caller.
func recordsRedeem(caller uuid.UUID) func(store.LogEntry, uuid.UUID) bool {
	return func(entry store.LogEntry, invitationID uuid.UUID) bool {
		if entry.Type != byte(e2ee.EntryRedeem) || len(entry.Payload) < 16 || !bytes.Equal(entry.Payload[:16], invitationID[:]) {
			return false
		}

		newcomer, err := e2ee.ParseBundle(entry.Payload[16:])

		return err == nil && newcomer.UserID == caller.String()
	}
}

// LogError maps the store errors of a membership log append, or returns nil.
func LogError(err error) error {
	switch {
	case errors.Is(err, store.ErrLogConflict):
		return connect.NewError(connect.CodeAborted,
			errors.New("log_entry.seq is not the next of the vault's log; list the log and retry on top of its head"))
	case errors.Is(err, store.ErrLogEntryRequired),
		errors.Is(err, store.ErrUnexpectedLogEntry),
		errors.Is(err, errLogEntryRefused):
		return connect.NewError(connect.CodeInvalidArgument, err)
	default:
		return nil
	}
}
