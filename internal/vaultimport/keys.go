package vaultimport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

// maxSecretFileBytes bounds a passphrase or private key file: a passphrase
// or an age identity with comments is far smaller.
const maxSecretFileBytes = 64 << 10

// maxListPages bounds the pages read from one list, against a server that
// never ends it.
const maxListPages = 10_000

// UserSecret is what unlocks the signed-in user's key pair in an end-to-end
// encrypted vault: the recovery passphrase or the private key itself. Its
// fields never appear in a log or an error.
type UserSecret struct {
	Passphrase string
	PrivateKey []byte
}

// ReadPassphraseFile reads a recovery passphrase from the file at path:
// the whole file, without one trailing line ending. Errors never quote the
// file's content.
func ReadPassphraseFile(path string) (string, error) {
	content, err := readSecretFile(path)
	if err != nil {
		return "", err
	}

	passphrase := strings.TrimSuffix(strings.TrimSuffix(string(content), "\n"), "\r")
	if passphrase == "" {
		return "", fmt.Errorf("the passphrase file %s is empty", path)
	}

	return passphrase, nil
}

// ReadPrivateKeyFile reads the user's private key from the file at path:
// one age hybrid identity (AGE-SECRET-KEY-PQ-1…), with blank lines and lines
// starting with "#" ignored. Errors never quote the file's content.
func ReadPrivateKeyFile(path string) ([]byte, error) {
	content, err := readSecretFile(path)
	if err != nil {
		return nil, err
	}

	var privateKey []byte

	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if privateKey != nil {
			return nil, fmt.Errorf("the private key file %s holds more than one key", path)
		}

		if privateKey, err = e2ee.ParseAgeIdentity(line); err != nil {
			return nil, fmt.Errorf("the private key file %s does not hold an age hybrid post-quantum identity (AGE-SECRET-KEY-PQ-1…)", path)
		}
	}

	if privateKey == nil {
		return nil, fmt.Errorf("the private key file %s holds no key", path)
	}

	return privateKey, nil
}

func readSecretFile(path string) ([]byte, error) {
	file, err := os.Open(path) //nolint:gosec // the path the user gave.
	if err != nil {
		return nil, err
	}

	defer func() { _ = file.Close() }()

	content, err := io.ReadAll(io.LimitReader(file, maxSecretFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	if len(content) > maxSecretFileBytes {
		return nil, fmt.Errorf("%s is larger than %d bytes", path, maxSecretFileBytes)
	}

	return content, nil
}

// userPrivateKey returns the signed-in user's private key: unlocked with
// the passphrase as the plugin does (GetUserKeyParams, then UnlockUserKey
// with the passphrase's auth key, then unwrapped here), or the given private
// key once it matches the user's public key.
func (client *apiClient) userPrivateKey(ctx context.Context, secret UserSecret) ([]byte, error) {
	stored, err := client.userKeys.GetUserKeyParams(ctx, connect.NewRequest(&vaultsyncv1.GetUserKeyParamsRequest{}))
	if connect.CodeOf(err) == connect.CodeNotFound {
		return nil, errors.New("you have no encryption key yet: enable end-to-end encryption in the plugin first")
	}

	if err != nil {
		return nil, fmt.Errorf("get your key's parameters: %w", err)
	}

	if secret.PrivateKey != nil {
		return checkedPrivateKey(secret.PrivateKey, stored.Msg.GetPublicKey())
	}

	params := stored.Msg.GetParams()
	if params.GetSuite() != uint32(e2ee.SuiteV2) {
		return nil, errors.New("your key uses an unknown crypto suite; update vault-sync-server")
	}

	if params.GetParallelism() > 255 {
		return nil, errors.New("your key's Argon2id parameters are out of bounds")
	}

	keys, err := e2ee.DerivePassphraseKeys(secret.Passphrase, e2ee.Argon2Params{
		Memory:      params.GetMemoryKib(),
		Iterations:  params.GetIterations(),
		Parallelism: uint8(params.GetParallelism()),
	}, params.GetSalt())
	if err != nil {
		return nil, errors.New("cannot derive keys from the passphrase with your key's parameters")
	}

	released, err := client.userKeys.UnlockUserKey(ctx, connect.NewRequest(&vaultsyncv1.UnlockUserKeyRequest{AuthKey: keys.AuthKey}))

	switch {
	case hasReason(err, vaultsyncv1.ErrorReason_ERROR_REASON_WRONG_PASSPHRASE):
		return nil, errors.New("the passphrase is wrong")
	case hasReason(err, vaultsyncv1.ErrorReason_ERROR_REASON_PASSPHRASE_ATTEMPTS_EXHAUSTED):
		return nil, errors.New("too many wrong passphrases; try again later")
	case err != nil:
		return nil, fmt.Errorf("unlock your key: %w", err)
	}

	publicKey := released.Msg.GetPublicKey()

	privateKey, err := e2ee.UnwrapWithKey(keys.WrapKey, released.Msg.GetWrappedPrivateKey(), e2ee.UserKeyAD(publicKey))
	if err != nil {
		return nil, errors.New("the key the server released does not open with this passphrase")
	}

	return checkedPrivateKey(privateKey, publicKey)
}

// checkedPrivateKey returns privateKey if it is the private key of
// publicKey.
func checkedPrivateKey(privateKey, publicKey []byte) ([]byte, error) {
	derived, err := e2ee.PublicKey(privateKey)
	if err != nil || !bytes.Equal(derived, publicKey) {
		return nil, errors.New("the private key is not the key of your account")
	}

	return privateKey, nil
}

// vaultKeys are the keys an import into an encrypted vault seals with.
type vaultKeys struct {
	// epoch is the vault's current epoch, which every revision is sealed
	// under.
	epoch uint64
	// content and path are the current epoch's sub-keys.
	content []byte
	path    []byte
	// pathKeySecret is epoch 1's: path keys use it for the vault's whole
	// life.
	pathKeySecret []byte
}

// slotOpener opens the key slots an import reads the vault's keys from:
// the user's own slots, or the vault's escrow slots.
type slotOpener struct {
	// kind is the recipient kind of the slots ListKeySlots is asked for.
	kind vaultsyncv1.KeyRecipientKind
	// whose names the slots in errors ("your", "the escrow").
	whose string
	// missing is the error format, with the epoch, for an epoch whose key
	// no slot holds.
	missing string
	// open opens a slot of kind and returns the epoch key it holds. It is
	// checked against the key commitment afterwards.
	open func(vaultID uuid.UUID, slot *vaultsyncv1.KeySlot) ([]byte, error)
	// genesisHash is the trust anchor the vault's membership log is
	// verified from: the user's anchor list's, or the operator's -genesis.
	genesisHash []byte
}

// userSlots opens the user's own key slots with the user's private key.
func userSlots(privateKey, genesisHash []byte) slotOpener {
	return slotOpener{
		genesisHash: genesisHash,
		kind:        vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER,
		whose:       "your",
		missing:     "you hold no key for the vault's epoch %d yet: wait until an owner's device shares it",
		open: func(vaultID uuid.UUID, slot *vaultsyncv1.KeySlot) ([]byte, error) {
			key, err := e2ee.OpenKeySlot(privateKey, slot.GetWrappedKey(), e2ee.KeySlot{
				VaultID: vaultID.String(), Epoch: uint64(slot.GetEpoch()), RecipientKind: e2ee.RecipientUser, RecipientID: slot.GetRecipientId(),
			})
			if err != nil {
				return nil, fmt.Errorf("your key slot for epoch %d does not open with your key", slot.GetEpoch())
			}

			return key, nil
		},
	}
}

// vaultKeys opens the key slots of epoch 1 and of the vault's current
// epoch with opener, and checks each key against its epoch's key
// commitment before it is used. Before it opens a slot, it verifies the
// vault's membership log from opener's genesis and the owner-signed records
// of both epochs, and refuses a log or epoch rolled back from seen, which it
// then advances.
func (client *apiClient) vaultKeys(ctx context.Context, vaultID uuid.UUID, opener slotOpener, seen *verifiedState) (*vaultKeys, error) {
	states, err := client.verifiedLog(ctx, vaultID, opener.genesisHash, seen)
	if err != nil {
		return nil, err
	}

	commitments := map[uint64][]byte{}
	records := map[uint64]*vaultsyncv1.EpochRecord{}

	var current uint64

	pageToken := ""

	for range maxListPages {
		response, err := client.keys.ListEpochs(ctx, connect.NewRequest(&vaultsyncv1.ListEpochsRequest{VaultId: vaultID.String(), PageToken: pageToken}))
		if err != nil {
			return nil, fmt.Errorf("list the vault's key epochs: %w", err)
		}

		current = uint64(response.Msg.GetCurrentEpoch())

		for _, epoch := range response.Msg.GetEpochs() {
			commitments[uint64(epoch.GetEpoch())] = epoch.GetCommitment()
			records[uint64(epoch.GetEpoch())] = epoch.GetRecord()
		}

		if pageToken = response.Msg.GetNextPageToken(); pageToken == "" {
			break
		}
	}

	if current == 0 {
		return nil, errors.New("the vault has no key yet: open it in the plugin on an owner's device first")
	}

	if current < seen.epoch {
		return nil, notVerified("the vault's epoch was rolled back from %d to %d", seen.epoch, current)
	}

	for _, epoch := range []uint64{1, current} {
		if err := verifyEpoch(vaultID, states, epoch, commitments, records); err != nil {
			return nil, err
		}
	}

	epochKeys := map[uint64][]byte{}
	pageToken = ""

	for range maxListPages {
		response, err := client.keys.ListKeySlots(ctx, connect.NewRequest(&vaultsyncv1.ListKeySlotsRequest{
			VaultId: vaultID.String(), PageToken: pageToken, RecipientKind: opener.kind,
		}))
		if err != nil {
			return nil, fmt.Errorf("list %s key slots: %w", opener.whose, err)
		}

		for _, slot := range response.Msg.GetSlots() {
			epoch := uint64(slot.GetEpoch())
			if (epoch != 1 && epoch != current) || slot.GetRecipientKind() != opener.kind || epochKeys[epoch] != nil {
				continue
			}

			key, err := opener.open(vaultID, slot)
			if err != nil {
				return nil, err
			}

			if err := e2ee.VerifyKeyCommitment(key, commitments[epoch], vaultID.String(), epoch); err != nil {
				return nil, fmt.Errorf("%s key slot for epoch %d fails the epoch's key commitment", opener.whose, epoch)
			}

			epochKeys[epoch] = key
		}

		if pageToken = response.Msg.GetNextPageToken(); pageToken == "" {
			break
		}
	}

	for _, epoch := range []uint64{1, current} {
		if epochKeys[epoch] == nil {
			return nil, fmt.Errorf(opener.missing, epoch)
		}
	}

	last := states[len(states)-1]
	*seen = verifiedState{logSeq: last.Seq, logHash: last.Hash, epoch: current}

	return deriveVaultKeys(current, epochKeys[current], epochKeys[1])
}

func deriveVaultKeys(epoch uint64, currentKey, firstKey []byte) (*vaultKeys, error) {
	keys := &vaultKeys{epoch: epoch}

	var err error

	if keys.content, err = e2ee.DeriveSubkey(currentKey, e2ee.LabelContent); err != nil {
		return nil, err
	}

	if keys.path, err = e2ee.DeriveSubkey(currentKey, e2ee.LabelPath); err != nil {
		return nil, err
	}

	if keys.pathKeySecret, err = e2ee.DeriveSubkey(firstKey, e2ee.LabelPathKeySecret); err != nil {
		return nil, err
	}

	return keys, nil
}

// hasReason reports whether err is a server error with an ErrorDetail of
// reason.
func hasReason(err error, reason vaultsyncv1.ErrorReason) bool {
	var connectErr *connect.Error
	if !errors.As(err, &connectErr) {
		return false
	}

	for _, detail := range connectErr.Details() {
		value, detailErr := detail.Value()
		if errorDetail, ok := value.(*vaultsyncv1.ErrorDetail); detailErr == nil && ok && errorDetail.GetReason() == reason {
			return true
		}
	}

	return false
}
