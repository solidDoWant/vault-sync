package vaultimport

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

// Verification against an active server (docs/design/encryption.md,
// "Protection against an active server" and "Import"): before the import
// uses an epoch key, it replays the vault's membership log from a genesis
// it trusts and checks the owner-signed record of every epoch it takes a key
// from, as a device does.

// errNotVerified prefixes every verification failure, in the plugin's words.
var errNotVerified = errors.New("the server sent key or membership data that doesn't verify")

func notVerified(format string, args ...any) error {
	return fmt.Errorf("%w: %s; nothing was imported", errNotVerified, fmt.Sprintf(format, args...))
}

// ParseGenesisHash parses the vault's genesis hash (its vault fingerprint) as
// 64 hexadecimal digits; spaces and colons between them are ignored.
func ParseGenesisHash(text string) ([]byte, error) {
	cleaned := strings.NewReplacer(" ", "", ":", "").Replace(strings.TrimSpace(text))

	hash, err := hex.DecodeString(cleaned)
	if err != nil || len(hash) != e2ee.HashSize {
		return nil, fmt.Errorf("%q is not a genesis hash: give the vault fingerprint as %d hexadecimal digits", text, 2*e2ee.HashSize)
	}

	return hash, nil
}

// verifiedState is what one import run has verified so far: the log
// position and hash and the epoch it last used. A later read of the vault's
// keys (after a rotation) refuses a shorter log, another hash at that
// position, or a lower epoch.
type verifiedState struct {
	logSeq  uint64
	logHash []byte
	epoch   uint64
}

// verifiedLog reads the vault's membership log and replays it from the
// trusted genesis, refusing a log rolled back from what this run verified.
func (client *apiClient) verifiedLog(ctx context.Context, vaultID uuid.UUID, genesisHash []byte, seen *verifiedState) ([]e2ee.LogState, error) {
	var entries []e2ee.Entry

	pageToken := ""

	for range maxListPages {
		response, err := client.keys.ListLogEntries(ctx, connect.NewRequest(&vaultsyncv1.ListLogEntriesRequest{VaultId: vaultID.String(), PageToken: pageToken}))
		if err != nil {
			return nil, fmt.Errorf("list the vault's membership log: %w", err)
		}

		for _, entry := range response.Msg.GetEntries() {
			if entry.GetType() > math.MaxUint8 {
				return nil, notVerified("the membership log holds an unknown entry type")
			}

			entries = append(entries, e2ee.Entry{
				VaultID:    vaultID.String(),
				Seq:        entry.GetSeq(),
				PrevHash:   entry.GetPrevHash(),
				Type:       e2ee.EntryType(entry.GetType()),
				Payload:    entry.GetPayload(),
				Signatures: entry.GetSignatures(),
			})
		}

		if pageToken = response.Msg.GetNextPageToken(); pageToken == "" {
			break
		}
	}

	states, err := e2ee.ReplayLog(vaultID.String(), entries, e2ee.ReplayOptions{GenesisHash: genesisHash})
	if err != nil {
		return nil, notVerified("the vault's membership log does not verify from its genesis")
	}

	if seen.logSeq > uint64(len(states)) || (seen.logSeq > 0 && !bytes.Equal(states[seen.logSeq-1].Hash, seen.logHash)) {
		return nil, notVerified("the vault's membership log was rolled back")
	}

	return states, nil
}

// verifyEpoch checks the owner's signed record of epoch against the
// replayed log; commitments are the vault's epoch commitments by epoch.
func verifyEpoch(vaultID uuid.UUID, states []e2ee.LogState, epoch uint64, commitments map[uint64][]byte, records map[uint64]*vaultsyncv1.EpochRecord) error {
	record := records[epoch]
	if record == nil {
		return notVerified("epoch %d has no owner-signed record", epoch)
	}

	prevCommitment := make([]byte, e2ee.MACSize)

	if epoch > 1 {
		if prevCommitment = commitments[epoch-1]; prevCommitment == nil {
			return notVerified("the commitment of epoch %d, which epoch %d's record signs, is missing", epoch-1, epoch)
		}
	}

	recipients := make([]e2ee.EpochRecipient, len(record.GetRecipients()))
	for index, recipient := range record.GetRecipients() {
		if recipient.GetKind() > math.MaxUint8 {
			return notVerified("epoch %d's record names an unknown recipient kind", epoch)
		}

		recipients[index] = e2ee.EpochRecipient{Kind: byte(recipient.GetKind()), ID: recipient.GetRecipientId(), KeyHash: recipient.GetKeyHash()}
	}

	if err := e2ee.VerifyEpochRecord(vaultID.String(), states, e2ee.EpochRecord{
		VaultID:        vaultID.String(),
		Epoch:          epoch,
		Commitment:     commitments[epoch],
		PrevCommitment: prevCommitment,
		LogSeq:         record.GetLogSeq(),
		LogHash:        record.GetLogHash(),
		Recipients:     recipients,
		Signature:      record.GetSignature(),
	}); err != nil {
		return notVerified("epoch %d is not signed by an owner in the verified membership log, or its recipients are not the log's", epoch)
	}

	return nil
}

// anchoredGenesis returns the vault's genesis hash from the user's sealed
// anchor list, opened with the user's private key. The user id the list is
// sealed for is the recipient of the user's own key slots: a server that
// names another user makes the list fail to open.
func (client *apiClient) anchoredGenesis(ctx context.Context, vaultID uuid.UUID, privateKey []byte) ([]byte, error) {
	slots, err := client.keys.ListKeySlots(ctx, connect.NewRequest(&vaultsyncv1.ListKeySlotsRequest{
		VaultId: vaultID.String(), RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER,
	}))
	if err != nil {
		return nil, fmt.Errorf("list your key slots: %w", err)
	}

	if len(slots.Msg.GetSlots()) == 0 {
		return nil, errors.New("you hold no key for the vault yet: wait until an owner's device shares it")
	}

	userID := slots.Msg.GetSlots()[0].GetRecipientId()

	list, err := client.userKeys.GetAnchorList(ctx, connect.NewRequest(&vaultsyncv1.GetAnchorListRequest{}))
	if err != nil {
		return nil, fmt.Errorf("get your anchor list: %w", err)
	}

	if list.Msg.GetVersion() == 0 {
		return nil, notVerified("your anchor list is empty, so the vault's genesis cannot be checked: open the vault in the plugin first")
	}

	if len(privateKey) < e2ee.PrivateKeySize {
		return nil, errors.New("your private key is too short")
	}

	anchorKey, err := e2ee.AnchorKey(privateKey[:e2ee.PrivateKeySize])
	if err != nil {
		return nil, err
	}

	anchors, err := e2ee.OpenAnchorList(anchorKey, list.Msg.GetSealedList(), userID, list.Msg.GetVersion())
	if err != nil {
		return nil, notVerified("your anchor list does not open with your key")
	}

	for _, anchor := range anchors {
		if anchor.VaultID == vaultID.String() {
			return anchor.GenesisHash, nil
		}
	}

	return nil, notVerified("your anchor list does not name this vault: open the vault in the plugin first")
}

// userOpener opens the user's own key slots, with the vault's log verified
// from the genesis in the user's anchor list.
func (client *apiClient) userOpener(ctx context.Context, vaultID uuid.UUID, privateKey []byte) (slotOpener, error) {
	genesisHash, err := client.anchoredGenesis(ctx, vaultID, privateKey)
	if err != nil {
		return slotOpener{}, err
	}

	return userSlots(privateKey, genesisHash), nil
}
