package api

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Converting a plaintext vault to end-to-end encryption in place
// (docs/design/encryption.md, "Converting a plaintext vault in place").

// errConversionMembers refuses a conversion whose log does not name the
// vault's members as the server has them: they changed since the owner's
// device listed them.
var errConversionMembers = errors.New("the membership log does not name exactly the vault's members, roles and keys; list them again and retry")

// ConvertVault switches the authorized plaintext vault to end-to-end
// encryption.
func (service VaultKeyService) ConvertVault(ctx context.Context, request *connect.Request[vaultsyncv1.ConvertVaultRequest]) (*connect.Response[vaultsyncv1.ConvertVaultResponse], error) {
	vault, user, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	membership, _ := authz.MembershipFromContext(ctx)
	message := request.Msg

	if message.GetEscrow() && !service.Escrow.Configured() {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("this server has no escrow key"))
	}

	_, genesis, err := verifyGenesis(membership.VaultID.String(), message.GetGenesis(), user.ID, message.GetEscrow())
	if err != nil {
		return nil, err
	}

	entries := []store.LogEntry{*genesis}

	// Every converted vault's log has a members entry: it marks the vault
	// as converted and signs the bound of its plaintext history.
	if message.GetMembersEntry() == nil {
		return nil, invalidArgument("members_entry is required")
	}

	membersEntry, err := parseMembersEntry(message.GetMembersEntry())
	if err != nil {
		return nil, err
	}

	entries = append(entries, membersEntry)

	logEntries := make([]e2ee.Entry, len(entries))
	for index, entry := range entries {
		logEntries[index] = e2eeEntry(membership.VaultID, entry)
	}

	states, err := e2ee.ReplayLog(membership.VaultID.String(), logEntries, service.Escrow.replayOptions())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errLogEntryRefused)
	}

	next, err := ParseNextEpoch(message.GetNextEpoch(), service.Escrow)
	if err != nil {
		return nil, err
	}

	if next.ExpectedEpoch != 0 {
		return nil, invalidArgument("next_epoch.expected_epoch must be 0: a converted vault starts at epoch 1")
	}

	signed, err := parseSignedEpoch(membership.VaultID, message.GetRecord(), nil, service.Escrow.replayOptions())
	if err != nil {
		return nil, err
	}

	// The record names the log's last entry, so its recipients are every
	// member the log names.
	signed.position = uint64(max(entries[len(entries)-1].Seq, 0))

	if next.Record, err = encodeEpochRecord(signed.record); err != nil {
		return nil, service.internal(ctx, "cannot convert vault", err)
	}

	next.Check = signed.check(next)

	pathKeys, err := parsePathKeys(message.GetPathKeys())
	if err != nil {
		return nil, err
	}

	head := states[len(states)-1]

	epoch, conversionSeq, err := vault.ConvertVault(ctx, user.ID, store.Conversion{
		Genesis:        *genesis,
		MembersEntry:   membersEntry,
		ConvertedAtSeq: head.ConvertedAtSeq,
		CheckMembers:   func(members []store.ConversionMember) error { return logNamesMembers(head, members) },
		Escrow:         message.GetEscrow(),
		Epoch:          next,
		PathKeys:       pathKeys,
	})
	if err != nil {
		return nil, service.conversionError(ctx, err)
	}

	return connect.NewResponse(&vaultsyncv1.ConvertVaultResponse{
		Epoch:         epochMessage(epoch),
		ConversionSeq: uint64(max(conversionSeq, 0)),
	}), nil
}

func (service VaultKeyService) conversionError(ctx context.Context, err error) error {
	if blocked, ok := errors.AsType[*store.ConversionBlockedError](err); ok {
		connectErr := connect.NewError(connect.CodeFailedPrecondition,
			errors.New("every member needs a user key and no invitation may be pending; see the error detail"))

		refused := &vaultsyncv1.ConversionRefused{}
		for _, id := range blocked.MembersWithoutKey {
			refused.MembersWithoutKey = append(refused.MembersWithoutKey, id.String())
		}

		for _, id := range blocked.PendingInvitations {
			refused.PendingInvitations = append(refused.PendingInvitations, id.String())
		}

		if detail, detailErr := connect.NewErrorDetail(refused); detailErr == nil {
			connectErr.AddDetail(detail)
		}

		return connectErr
	}

	switch {
	case errors.Is(err, store.ErrVaultEncrypted):
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("the vault is already end-to-end encrypted"))
	case errors.Is(err, errConversionMembers):
		return connect.NewError(connect.CodeAborted, err)
	case errors.Is(err, store.ErrConversionHeadMoved):
		return connect.NewError(connect.CodeAborted, errors.New("the vault changed since the members entry's converted_at_seq; sync and retry"))
	case errors.Is(err, store.ErrConversionStale):
		return connect.NewError(connect.CodeAborted, errors.New("path_keys do not name exactly the vault's live documents; list them again and retry"))
	case errors.Is(err, store.ErrPathKeyTaken):
		return invalidArgument("two live documents have the same path key")
	}

	if mapped := KeyError(err); mapped != nil {
		return mapped
	}

	return service.internal(ctx, "cannot convert vault", err)
}

// parseMembersEntry bounds a conversion's members entry and converts it.
func parseMembersEntry(message *vaultsyncv1.LogEntry) (store.LogEntry, error) {
	refused := connect.NewError(connect.CodeInvalidArgument, errLogEntryRefused)

	if message.GetType() != uint32(e2ee.EntryMembers) || message.GetSeq() != 2 ||
		len(message.GetPrevHash()) != e2ee.HashSize || len(message.GetPayload()) > e2ee.MaxMembersPayloadSize ||
		len(message.GetSignatures()) != 1 || len(message.GetSignatures()[0]) != ed25519.SignatureSize {
		return store.LogEntry{}, refused
	}

	return store.LogEntry{
		Seq:        2,
		PrevHash:   message.GetPrevHash(),
		Type:       byte(e2ee.EntryMembers),
		Payload:    message.GetPayload(),
		Signatures: message.GetSignatures(),
	}, nil
}

// parsePathKeys returns the path key of each listed document, refusing a
// malformed entry or a document listed twice.
func parsePathKeys(messages []*vaultsyncv1.DocumentPathKey) (map[uuid.UUID]string, error) {
	pathKeys := make(map[uuid.UUID]string, len(messages))

	for index, message := range messages {
		id, err := authz.ParseID(message.GetDocumentId())
		if err != nil {
			return nil, invalidArgument("path_keys[%d].document_id: %w", index, err)
		}

		if len(message.GetPathKey()) != EncryptedPathKeyBytes {
			return nil, invalidArgument("path_keys[%d].path_key must be the %d-byte HMAC of the path", index, EncryptedPathKeyBytes)
		}

		if _, ok := pathKeys[id]; ok {
			return nil, invalidArgument("path_keys[%d]: document %s is listed twice", index, id)
		}

		pathKeys[id] = string(message.GetPathKey())
	}

	return pathKeys, nil
}

// logNamesMembers returns errConversionMembers unless the log state names
// exactly members, each with its role and current keys.
func logNamesMembers(state e2ee.LogState, members []store.ConversionMember) error {
	if len(state.Members) != len(members) {
		return errConversionMembers
	}

	for _, member := range members {
		named, ok := state.Members[member.UserID.String()]
		if !ok || named.Role != logRole(member.Role) ||
			!bytes.Equal(named.Bundle.SignPub, member.SignPublicKey) || !bytes.Equal(named.Bundle.KEMPub, member.PublicKey) {
			return errConversionMembers
		}
	}

	return nil
}
