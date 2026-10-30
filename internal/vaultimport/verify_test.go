package vaultimport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/e2ee/logtest"
)

// activeServer is a server under an attacker's control: it serves whatever
// log, epochs, slots and anchor list a test gives it.
type activeServer struct {
	vaultsyncv1connect.UnimplementedVaultKeyServiceHandler

	entries       []*vaultsyncv1.LogEntry
	epochs        []*vaultsyncv1.KeyEpoch
	slots         []*vaultsyncv1.KeySlot
	anchorVersion uint64
	anchorSealed  []byte
}

func (server *activeServer) ListLogEntries(context.Context, *connect.Request[vaultsyncv1.ListLogEntriesRequest]) (*connect.Response[vaultsyncv1.ListLogEntriesResponse], error) {
	return connect.NewResponse(&vaultsyncv1.ListLogEntriesResponse{Entries: server.entries}), nil
}

func (server *activeServer) ListEpochs(context.Context, *connect.Request[vaultsyncv1.ListEpochsRequest]) (*connect.Response[vaultsyncv1.ListEpochsResponse], error) {
	return connect.NewResponse(&vaultsyncv1.ListEpochsResponse{Epochs: server.epochs, CurrentEpoch: server.epochs[len(server.epochs)-1].GetEpoch()}), nil
}

func (server *activeServer) ListKeySlots(_ context.Context, request *connect.Request[vaultsyncv1.ListKeySlotsRequest]) (*connect.Response[vaultsyncv1.ListKeySlotsResponse], error) {
	kind := request.Msg.GetRecipientKind()
	if kind == vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_UNSPECIFIED {
		kind = vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER
	}

	var slots []*vaultsyncv1.KeySlot

	for _, slot := range server.slots {
		if slot.GetRecipientKind() == kind {
			slots = append(slots, slot)
		}
	}

	return connect.NewResponse(&vaultsyncv1.ListKeySlotsResponse{Slots: slots}), nil
}

type anchorServer struct {
	vaultsyncv1connect.UnimplementedUserKeyServiceHandler

	server *activeServer
}

func (anchors anchorServer) GetAnchorList(context.Context, *connect.Request[vaultsyncv1.GetAnchorListRequest]) (*connect.Response[vaultsyncv1.GetAnchorListResponse], error) {
	return connect.NewResponse(&vaultsyncv1.GetAnchorListResponse{Version: anchors.server.anchorVersion, SealedList: anchors.server.anchorSealed}), nil
}

// keyFixture is an escrowed vault with a valid log (the owner's genesis,
// then an editor joining), epoch 1 at the genesis and epoch 2 after the
// join, each wrapped to the owner and to the escrow key.
type keyFixture struct {
	vaultID  uuid.UUID
	ownerID  uuid.UUID
	log      *logtest.Log
	escrow   e2ee.EscrowBundle
	identity EscrowIdentity
	// genesisHash is the real genesis: the owner's anchor and the
	// operator's -genesis.
	genesisHash []byte
	server      *activeServer
	client      *apiClient
}

func newKeyFixture(t *testing.T) *keyFixture {
	t.Helper()

	escrowPrivate, escrowPublic, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	recipient, err := e2ee.AgeRecipient(escrowPublic)
	require.NoError(t, err)

	escrowKeyID, err := e2ee.EscrowKeyID(escrowPublic)
	require.NoError(t, err)

	escrowSignPub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	fixture := &keyFixture{
		vaultID:  uuid.Must(uuid.NewV7()),
		ownerID:  uuid.Must(uuid.NewV7()),
		escrow:   e2ee.EscrowBundle{SignPub: escrowSignPub, Recipient: recipient},
		identity: EscrowIdentity{PrivateKey: escrowPrivate, KeyID: escrowKeyID},
		server:   &activeServer{},
	}

	fixture.log = logtest.New(t, fixture.vaultID, fixture.ownerID, &fixture.escrow)
	fixture.genesisHash, err = fixture.log.Entries[0].Hash()
	require.NoError(t, err)

	first := fixture.addEpoch(t, fixture.log, fixture.log.SignKey(fixture.ownerID), nil)
	fixture.log.Join(t, fixture.ownerID, uuid.Must(uuid.NewV7()), e2ee.RoleEditor)
	fixture.addEpoch(t, fixture.log, fixture.log.SignKey(fixture.ownerID), first)
	fixture.serveLog(fixture.log, len(fixture.log.Entries))

	anchorKey, err := e2ee.AnchorKey(fixture.userPrivateKey())
	require.NoError(t, err)

	fixture.server.anchorVersion = 3
	fixture.server.anchorSealed, err = e2ee.SealAnchorList(anchorKey, fixture.ownerID.String(), 3, []e2ee.Anchor{
		{VaultID: uuid.Must(uuid.NewV7()).String(), GenesisHash: make([]byte, e2ee.HashSize)},
		{VaultID: fixture.vaultID.String(), GenesisHash: fixture.genesisHash},
	})
	require.NoError(t, err)

	mux := http.NewServeMux()
	mux.Handle(vaultsyncv1connect.NewVaultKeyServiceHandler(fixture.server))
	mux.Handle(vaultsyncv1connect.NewUserKeyServiceHandler(anchorServer{server: fixture.server}))

	httpServer := httptest.NewServer(mux)
	t.Cleanup(httpServer.Close)

	fixture.client = &apiClient{
		keys:     vaultsyncv1connect.NewVaultKeyServiceClient(httpServer.Client(), httpServer.URL),
		userKeys: vaultsyncv1connect.NewUserKeyServiceClient(httpServer.Client(), httpServer.URL),
	}

	return fixture
}

func (fixture *keyFixture) userPrivateKey() []byte {
	return fixture.log.Secrets[fixture.ownerID.String()].KEMSeed
}

// serveLog serves the first count entries of log.
func (fixture *keyFixture) serveLog(log *logtest.Log, count int) {
	fixture.server.entries = nil
	for _, entry := range log.Entries[:count] {
		fixture.server.entries = append(fixture.server.entries, logtest.EntryMessage(entry))
	}
}

// addEpoch serves the next epoch with a fresh key wrapped to the owner and
// the escrow key, and a record at log's head signed by signKey; it returns
// the epoch's commitment.
func (fixture *keyFixture) addEpoch(t *testing.T, log *logtest.Log, signKey ed25519.PrivateKey, prevCommitment []byte) []byte {
	t.Helper()

	return fixture.addEpochAt(t, log, signKey, prevCommitment, uint64(len(log.Entries)))
}

// addEpochAt is addEpoch with the record at log position seq.
func (fixture *keyFixture) addEpochAt(t *testing.T, log *logtest.Log, signKey ed25519.PrivateKey, prevCommitment []byte, seq uint64) []byte {
	t.Helper()

	epoch := uint64(len(fixture.server.epochs)) + 1
	vaultID := fixture.vaultID.String()

	epochKey, err := e2ee.GenerateKey()
	require.NoError(t, err)

	commitment, err := e2ee.KeyCommitment(epochKey, vaultID, epoch)
	require.NoError(t, err)

	userPublic, err := e2ee.PublicKey(fixture.userPrivateKey())
	require.NoError(t, err)

	userSlot, err := e2ee.SealKeySlot(userPublic, epochKey, e2ee.KeySlot{VaultID: vaultID, Epoch: epoch, RecipientKind: e2ee.RecipientUser, RecipientID: fixture.ownerID.String()})
	require.NoError(t, err)

	escrowPublic, err := e2ee.PublicKey(fixture.identity.PrivateKey)
	require.NoError(t, err)

	escrowSlot, err := e2ee.SealKeySlot(escrowPublic, epochKey, e2ee.KeySlot{VaultID: vaultID, Epoch: epoch, RecipientKind: e2ee.RecipientEscrow, RecipientID: fixture.identity.KeyID})
	require.NoError(t, err)

	if prevCommitment == nil {
		prevCommitment = make([]byte, e2ee.MACSize)
	}

	head := log.States(t)[seq-1]

	recipients, err := e2ee.EpochRecipients(head)
	require.NoError(t, err)

	record, err := e2ee.EpochRecord{
		VaultID: vaultID, Epoch: epoch, Commitment: commitment, PrevCommitment: prevCommitment,
		LogSeq: head.Seq, LogHash: head.Hash, Recipients: recipients,
	}.Sign(signKey)
	require.NoError(t, err)

	fixture.server.epochs = append(fixture.server.epochs, &vaultsyncv1.KeyEpoch{
		Epoch: uint32(epoch), Commitment: commitment, Record: logtest.RecordMessage(record), //nolint:gosec // a test's few epochs.
	})
	fixture.server.slots = append(fixture.server.slots,
		&vaultsyncv1.KeySlot{Epoch: uint32(epoch), RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER, RecipientId: fixture.ownerID.String(), WrappedKey: userSlot},   //nolint:gosec // a test's few epochs.
		&vaultsyncv1.KeySlot{Epoch: uint32(epoch), RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW, RecipientId: fixture.identity.KeyID, WrappedKey: escrowSlot}, //nolint:gosec // a test's few epochs.
	)

	return commitment
}

// dropEpoch stops serving the last epoch and its slots, and returns the
// commitment of the one before it.
func (fixture *keyFixture) dropEpoch() []byte {
	last := fixture.server.epochs[len(fixture.server.epochs)-1].GetEpoch()
	fixture.server.epochs = fixture.server.epochs[:len(fixture.server.epochs)-1]

	var slots []*vaultsyncv1.KeySlot

	for _, slot := range fixture.server.slots {
		if slot.GetEpoch() != last {
			slots = append(slots, slot)
		}
	}

	fixture.server.slots = slots

	return fixture.server.epochs[len(fixture.server.epochs)-1].GetCommitment()
}

// importPath reads the vault's keys as one import path does: through the
// user's anchor list, or the escrow identity with genesisHash (-genesis).
type importPath struct {
	name   string
	opener func(t *testing.T, fixture *keyFixture) (slotOpener, error)
}

var importPaths = []importPath{
	{name: "passphrase", opener: func(t *testing.T, fixture *keyFixture) (slotOpener, error) {
		return fixture.client.userOpener(t.Context(), fixture.vaultID, fixture.userPrivateKey())
	}},
	{name: "escrow", opener: func(_ *testing.T, fixture *keyFixture) (slotOpener, error) {
		return escrowSlots([]EscrowIdentity{fixture.identity}, fixture.genesisHash), nil
	}},
}

func readKeys(t *testing.T, path importPath, fixture *keyFixture, seen *verifiedState) (*vaultKeys, error) {
	t.Helper()

	opener, err := path.opener(t, fixture)
	if err != nil {
		return nil, err
	}

	return fixture.client.vaultKeys(t.Context(), fixture.vaultID, opener, seen)
}

func TestVaultKeysVerifyTheLogAndSignedEpochs(t *testing.T) {
	for _, path := range importPaths {
		t.Run(path.name, func(t *testing.T) {
			t.Run("a valid log and signed epochs are used", func(t *testing.T) {
				fixture := newKeyFixture(t)

				keys, err := readKeys(t, path, fixture, &verifiedState{})
				require.NoError(t, err)
				assert.Equal(t, uint64(2), keys.epoch)
			})

			for _, attack := range []struct {
				name   string
				attack func(t *testing.T, fixture *keyFixture)
			}{
				{
					name: "an injected epoch signed by a key outside the log",
					attack: func(t *testing.T, fixture *keyFixture) {
						_, serverKey, err := ed25519.GenerateKey(rand.Reader)
						require.NoError(t, err)

						fixture.addEpoch(t, fixture.log, serverKey, fixture.server.epochs[1].GetCommitment())
					},
				},
				{
					name: "an injected epoch signed by a member who is not an owner",
					attack: func(t *testing.T, fixture *keyFixture) {
						for userID := range fixture.log.Secrets {
							if userID != fixture.ownerID.String() {
								fixture.addEpoch(t, fixture.log, fixture.log.SignKey(uuid.MustParse(userID)), fixture.server.epochs[1].GetCommitment())
							}
						}
					},
				},
				{
					name: "an injected epoch without a record",
					attack: func(t *testing.T, fixture *keyFixture) {
						fixture.addEpoch(t, fixture.log, fixture.log.SignKey(fixture.ownerID), fixture.server.epochs[1].GetCommitment())
						fixture.server.epochs[2].Record = nil
					},
				},
				{
					name: "a swapped owner key: a forged log under the server's key, with every epoch signed by it",
					attack: func(t *testing.T, fixture *keyFixture) {
						forged := logtest.New(t, fixture.vaultID, fixture.ownerID, &fixture.escrow)
						fixture.serveLog(forged, len(forged.Entries))
						fixture.server.epochs, fixture.server.slots = nil, nil
						first := fixture.addEpoch(t, forged, forged.SignKey(fixture.ownerID), nil)
						fixture.addEpoch(t, forged, forged.SignKey(fixture.ownerID), first)
					},
				},
				{
					name: "an injected epoch signed at a log position before the previous epoch's",
					attack: func(t *testing.T, fixture *keyFixture) {
						fixture.addEpochAt(t, fixture.log, fixture.log.SignKey(fixture.ownerID), fixture.server.epochs[1].GetCommitment(), 1)
					},
				},
				{
					name: "a current epoch signed before the log's last member removal",
					attack: func(t *testing.T, fixture *keyFixture) {
						for userID := range fixture.log.Secrets {
							if userID != fixture.ownerID.String() {
								payload, err := e2ee.IDPayload(userID)
								require.NoError(t, err)

								removal := fixture.log.Entry(t, e2ee.EntryRemoveMember, payload, fixture.log.SignKey(fixture.ownerID))
								fixture.log.Entries = append(fixture.log.Entries, removal)
							}
						}

						fixture.serveLog(fixture.log, len(fixture.log.Entries))
					},
				},
				{
					name: "a swapped recipient key in an epoch record",
					attack: func(t *testing.T, fixture *keyFixture) {
						fixture.server.epochs[1].Record.Recipients[0].KeyHash = make([]byte, e2ee.HashSize)
					},
				},
				{
					name: "a log rolled back before the position the current epoch names",
					attack: func(t *testing.T, fixture *keyFixture) {
						fixture.serveLog(fixture.log, 1)
					},
				},
			} {
				t.Run(attack.name+" is refused", func(t *testing.T) {
					fixture := newKeyFixture(t)
					attack.attack(t, fixture)

					keys, err := readKeys(t, path, fixture, &verifiedState{})
					require.ErrorIs(t, err, errNotVerified)
					assert.Nil(t, keys)
				})
			}

			t.Run("a log or epoch rolled back during the run is refused", func(t *testing.T) {
				fixture := newKeyFixture(t)
				fixture.log.Join(t, fixture.ownerID, uuid.Must(uuid.NewV7()), e2ee.RoleViewer)
				fixture.serveLog(fixture.log, len(fixture.log.Entries))

				seen := &verifiedState{}
				_, err := readKeys(t, path, fixture, seen)
				require.NoError(t, err)

				// Epoch 2 names seq 3, so a log cut back to it still holds every record.
				fixture.serveLog(fixture.log, 3)
				_, err = readKeys(t, path, fixture, seen)
				require.ErrorIs(t, err, errNotVerified, "a shorter log")

				fixture.serveLog(fixture.log, len(fixture.log.Entries))
				fixture.dropEpoch()
				_, err = readKeys(t, path, fixture, seen)
				require.ErrorIs(t, err, errNotVerified, "a lower epoch")
			})
		})
	}
}

func TestVaultKeysRefuseAnotherGenesis(t *testing.T) {
	t.Run("the escrow import with a different -genesis", func(t *testing.T) {
		fixture := newKeyFixture(t)
		fixture.genesisHash = make([]byte, e2ee.HashSize)

		_, err := readKeys(t, importPaths[1], fixture, &verifiedState{})
		require.ErrorIs(t, err, errNotVerified)
	})

	t.Run("an anchor list without the vault", func(t *testing.T) {
		fixture := newKeyFixture(t)

		anchorKey, err := e2ee.AnchorKey(fixture.userPrivateKey())
		require.NoError(t, err)

		fixture.server.anchorSealed, err = e2ee.SealAnchorList(anchorKey, fixture.ownerID.String(), 3, nil)
		require.NoError(t, err)

		_, err = readKeys(t, importPaths[0], fixture, &verifiedState{})
		require.ErrorIs(t, err, errNotVerified)
	})

	t.Run("no anchor list", func(t *testing.T) {
		fixture := newKeyFixture(t)
		fixture.server.anchorVersion, fixture.server.anchorSealed = 0, nil

		_, err := readKeys(t, importPaths[0], fixture, &verifiedState{})
		require.ErrorIs(t, err, errNotVerified)
	})

	t.Run("an anchor list sealed at another version", func(t *testing.T) {
		fixture := newKeyFixture(t)
		fixture.server.anchorVersion = 2

		_, err := readKeys(t, importPaths[0], fixture, &verifiedState{})
		require.ErrorIs(t, err, errNotVerified)
	})
}
