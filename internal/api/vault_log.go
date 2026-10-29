package api

import (
	"context"
	"encoding/binary"
	"math"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// The membership log of E2EE vaults (docs/design/crypto.md, "Identity keys,
// the membership log and signed epochs").

// verifyGenesis checks the vault id and genesis entry of an E2EE
// CreateVault: the genesis must verify as the first entry of the vault's
// log (e2ee.ReplayLog), name creatorID as its creator, and record an escrow
// bundle exactly when escrow is requested.
func verifyGenesis(rawVaultID string, genesis *vaultsyncv1.LogEntry, creatorID uuid.UUID, escrow bool) (uuid.UUID, *store.LogEntry, error) {
	vaultID, err := uuid.Parse(rawVaultID)
	if err != nil || vaultID == uuid.Nil {
		return uuid.Nil, nil, invalidArgument("new_vault_id must be a UUID chosen by the creator for an E2EE vault")
	}

	if genesis == nil {
		return uuid.Nil, nil, invalidArgument("an E2EE vault needs its genesis entry")
	}

	if genesis.GetType() > math.MaxUint8 || genesis.GetSeq() > math.MaxInt64 {
		return uuid.Nil, nil, invalidArgument("genesis does not verify")
	}

	entry := e2ee.Entry{
		VaultID:    vaultID.String(),
		Seq:        genesis.GetSeq(),
		PrevHash:   genesis.GetPrevHash(),
		Type:       e2ee.EntryType(genesis.GetType()),
		Payload:    genesis.GetPayload(),
		Signatures: genesis.GetSignatures(),
	}

	states, err := e2ee.ReplayLog(entry.VaultID, []e2ee.Entry{entry}, e2ee.ReplayOptions{})
	if err != nil {
		return uuid.Nil, nil, invalidArgument("genesis does not verify")
	}

	state := states[0]
	if _, ok := state.Members[creatorID.String()]; !ok {
		return uuid.Nil, nil, invalidArgument("genesis must name the caller as the vault's creator")
	}

	if (state.Escrow != nil) != escrow {
		return uuid.Nil, nil, invalidArgument("genesis must record an escrow key exactly when escrow is requested")
	}

	return vaultID, &store.LogEntry{
		Seq:        int64(entry.Seq), //nolint:gosec // checked against MaxInt64 above.
		PrevHash:   entry.PrevHash,
		Type:       byte(entry.Type),
		Payload:    entry.Payload,
		Signatures: entry.Signatures,
	}, nil
}

// ListLogEntries lists the vault's membership log.
func (service VaultKeyService) ListLogEntries(ctx context.Context, request *connect.Request[vaultsyncv1.ListLogEntriesRequest]) (*connect.Response[vaultsyncv1.ListLogEntriesResponse], error) {
	vault, _, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	after, err := decodeLogToken(request.Msg.GetPageToken())
	if err != nil {
		return nil, err
	}

	limit := pageSize(request.Msg.GetPageSize(), DefaultKeyPageSize, MaxKeyPageSize)

	entries, err := vault.ListLogEntries(ctx, after, limit)
	if err != nil {
		return nil, service.internal(ctx, "cannot list log entries", err)
	}

	response := &vaultsyncv1.ListLogEntriesResponse{}
	budget := newPageBudget(request.Header(), service.Limits.MaxResponseBytes)

	for index, entry := range entries {
		message := logEntryMessage(entry)
		if !budget.admit(message) {
			response.NextPageToken = encodeLogToken(entries[index-1].Seq)

			break
		}

		response.Entries = append(response.Entries, message)

		if index == limit-1 {
			response.NextPageToken = encodeLogToken(entry.Seq)
		}
	}

	return connect.NewResponse(response), nil
}

func logEntryMessage(entry store.LogEntry) *vaultsyncv1.LogEntry {
	return &vaultsyncv1.LogEntry{
		Seq:        uint64(max(entry.Seq, 0)),
		PrevHash:   entry.PrevHash,
		Type:       uint32(entry.Type),
		Payload:    entry.Payload,
		Signatures: entry.Signatures,
	}
}

// encodeLogToken encodes a ListLogEntries page token: the seq of the last
// entry on the previous page (8 bytes, big-endian).
func encodeLogToken(seq int64) string {
	return keyTokenEncoding.EncodeToString(binary.BigEndian.AppendUint64(nil, uint64(max(seq, 0))))
}

// decodeLogToken returns the seq a page token encodes, or 0 for no token.
func decodeLogToken(token string) (int64, error) {
	if token == "" {
		return 0, nil
	}

	raw, err := keyTokenEncoding.DecodeString(token)
	if err != nil || len(raw) != 8 || binary.BigEndian.Uint64(raw) > math.MaxInt64 {
		return 0, invalidArgument("page_token is malformed")
	}

	return int64(binary.BigEndian.Uint64(raw)), nil //nolint:gosec // checked against MaxInt64 above.
}
