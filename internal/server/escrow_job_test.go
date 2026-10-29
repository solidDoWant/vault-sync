package server_test

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
)

var jobToken = strings.Repeat("j", 44)

// memoryEscrowJobStore is an in-memory escrow chain and escrow slot store
// with the store's conditional rules.
type memoryEscrowJobStore struct {
	mutex sync.Mutex
	chain store.EscrowChain
	// slots maps vault and epoch to the escrow key id of its one slot.
	slots map[string]string
	calls int
}

func slotKey(vaultID uuid.UUID, epoch int32) string {
	return fmt.Sprintf("%s/%d", vaultID, epoch)
}

func (memory *memoryEscrowJobStore) EscrowChain(_ context.Context, _ []byte) (store.EscrowChain, error) {
	memory.mutex.Lock()
	defer memory.mutex.Unlock()

	return store.EscrowChain{Root: memory.chain.Root, Rotations: append([]store.EscrowRotationStatement(nil), memory.chain.Rotations...)}, nil
}

func (memory *memoryEscrowJobStore) AppendEscrowRotation(_ context.Context, position int32, statement store.EscrowRotationStatement) error {
	memory.mutex.Lock()
	defer memory.mutex.Unlock()

	memory.calls++

	if int(position) != len(memory.chain.Rotations)+1 {
		return store.ErrEscrowChainPosition
	}

	memory.chain.Rotations = append(memory.chain.Rotations, statement)

	return nil
}

func (memory *memoryEscrowJobStore) ReplaceEscrowSlot(_ context.Context, replacement store.EscrowSlotReplacement) error {
	memory.mutex.Lock()
	defer memory.mutex.Unlock()

	memory.calls++

	key := slotKey(replacement.VaultID, replacement.Epoch)
	if memory.slots[key] != replacement.OldRecipientID {
		return store.ErrNotFound
	}

	memory.slots[key] = replacement.NewRecipientID

	return nil
}

func keyIDOf(t *testing.T, key escrowKey) string {
	t.Helper()

	return escrowFor(t, key).KeyID
}

type escrowJobFixture struct {
	running *runningServer
	store   *memoryEscrowJobStore
	issuer  *authtest.Issuer
	key     authtest.Key
	members *memoryStore
}

func newEscrowJobFixture(t *testing.T, token string) *escrowJobFixture {
	t.Helper()

	issuer := authtest.NewIssuer(t)
	fixture := &escrowJobFixture{issuer: issuer, key: issuer.AddKey(t, jose.RS256), members: newMemoryStore(), store: &memoryEscrowJobStore{slots: map[string]string{}}}

	verifier := auth.NewVerifier(auth.VerifierOptions{IssuerURL: issuer.URL, Audience: authtest.DefaultAudience, Logger: slog.New(slog.DiscardHandler)})

	fixture.running = startServer(t, server.Options{
		Authenticator:  auth.NewAuthenticator(verifier, fixture.members),
		Devices:        fixture.members,
		EscrowJobs:     &api.EscrowJobService{Store: fixture.store},
		EscrowJobToken: []byte(token),
	})

	return fixture
}

func (fixture *escrowJobFixture) client() vaultsyncv1connect.EscrowJobServiceClient {
	return vaultsyncv1connect.NewEscrowJobServiceClient(http.DefaultClient, fixture.running.apiURL())
}

func withAuthorization[T any](message *T, authorization string) *connect.Request[T] {
	request := connect.NewRequest(message)
	if authorization != "" {
		request.Header().Set("Authorization", authorization)
	}

	return request
}

// callEveryEscrowJobRPC calls each RPC of the service with authorization
// and returns their errors by procedure.
func callEveryEscrowJobRPC(t *testing.T, client vaultsyncv1connect.EscrowJobServiceClient, authorization string) map[string]error {
	t.Helper()

	_, replaceErr := client.ReplaceEscrowSlot(t.Context(), withAuthorization(&vaultsyncv1.ReplaceEscrowSlotRequest{}, authorization))
	_, appendErr := client.AppendEscrowRotation(t.Context(), withAuthorization(&vaultsyncv1.AppendEscrowRotationRequest{}, authorization))

	return map[string]error{
		vaultsyncv1connect.EscrowJobServiceReplaceEscrowSlotProcedure:    replaceErr,
		vaultsyncv1connect.EscrowJobServiceAppendEscrowRotationProcedure: appendErr,
	}
}

func TestEscrowJobServiceRefusesEveryoneButTheJob(t *testing.T) {
	fixture := newEscrowJobFixture(t, jobToken)

	// A user who signed in, registered a device and owns vaults on other
	// services is still nobody here.
	userToken := authtest.Sign(t, fixture.key, fixture.issuer.Claims("owner", time.Now()))
	_, err := vaultsyncv1connect.NewDeviceServiceClient(http.DefaultClient, fixture.running.apiURL()).
		RegisterDevice(t.Context(), withAuthorization(&vaultsyncv1.RegisterDeviceRequest{Name: "laptop"}, "Bearer "+userToken))
	require.NoError(t, err, "the OIDC token is valid")

	for name, authorization := range map[string]string{
		"anonymous":                    "",
		"a member's or owner's token":  "Bearer " + userToken,
		"a wrong job token":            "Bearer " + strings.Repeat("k", 44),
		"the job token one char short": "Bearer " + jobToken[1:],
		"the job token one char long":  "Bearer " + jobToken + "j",
		"the job token without Bearer": jobToken,
		"the job token as Basic":       "Basic " + jobToken,
	} {
		t.Run(name, func(t *testing.T) {
			for procedure, err := range callEveryEscrowJobRPC(t, fixture.client(), authorization) {
				assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), procedure)
			}
		})
	}

	assert.Zero(t, fixture.store.calls, "no refused call reaches the store")

	t.Run("the job token", func(t *testing.T) {
		for procedure, err := range callEveryEscrowJobRPC(t, fixture.client(), "Bearer "+jobToken) {
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "%s reaches the handler: %v", procedure, err)
		}
	})
}

func TestEscrowJobServiceIsOffWithoutAToken(t *testing.T) {
	fixture := newEscrowJobFixture(t, "")

	for _, authorization := range []string{"", "Bearer ", "Bearer " + jobToken} {
		for procedure, err := range callEveryEscrowJobRPC(t, fixture.client(), authorization) {
			assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), "%s with %q", procedure, authorization)
		}
	}

	assert.Zero(t, fixture.store.calls)
}

func TestAppendEscrowRotationVerifiesAgainstTheChainHead(t *testing.T) {
	first, second, third := newEscrowKey(t), newEscrowKey(t), newEscrowKey(t)

	fixture := newEscrowJobFixture(t, jobToken)
	client := fixture.client()

	appendStatement := func(statement store.EscrowRotationStatement) error {
		_, err := client.AppendEscrowRotation(t.Context(), withAuthorization(&vaultsyncv1.AppendEscrowRotationRequest{
			Statement: &vaultsyncv1.EscrowRotationStatement{OldBundleHash: statement.OldBundleHash, NewBundle: statement.NewBundle, Signature: statement.Signature},
		}, "Bearer "+jobToken))

		return err
	}

	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(appendStatement(rotate(t, first.sign, first, second))), "no chain yet")

	fixture.store.chain = store.EscrowChain{Root: first.encoded}

	tampered := rotate(t, first.sign, first, second)
	tampered.Signature[0] ^= 1

	for name, statement := range map[string]store.EscrowRotationStatement{
		"signed by the new key":      rotate(t, second.sign, first, second),
		"from a bundle not the head": rotate(t, second.sign, second, third),
		"a tampered signature":       tampered,
		"a malformed new bundle":     {OldBundleHash: tampered.OldBundleHash, NewBundle: []byte("bundle"), Signature: tampered.Signature},
	} {
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(appendStatement(statement)), name)
	}

	assert.Empty(t, fixture.store.chain.Rotations, "nothing refused is stored")

	require.NoError(t, appendStatement(rotate(t, first.sign, first, second)))
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(appendStatement(rotate(t, first.sign, first, third))), "the head is now the second key")
	require.NoError(t, appendStatement(rotate(t, second.sign, second, third)))

	head, err := e2ee.VerifyEscrowChain(first.bundle, []e2ee.EscrowRotation{
		{OldBundleHash: fixture.store.chain.Rotations[0].OldBundleHash, NewBundle: second.bundle, Signature: fixture.store.chain.Rotations[0].Signature},
		{OldBundleHash: fixture.store.chain.Rotations[1].OldBundleHash, NewBundle: third.bundle, Signature: fixture.store.chain.Rotations[1].Signature},
	})
	require.NoError(t, err)
	assert.Equal(t, third.bundle, head)
}

func TestReplaceEscrowSlotOnlyWrapsToTheChainHead(t *testing.T) {
	old, next := newEscrowKey(t), newEscrowKey(t)
	oldID, nextID := keyIDOf(t, old), keyIDOf(t, next)

	fixture := newEscrowJobFixture(t, jobToken)
	fixture.store.chain = store.EscrowChain{Root: old.encoded, Rotations: []store.EscrowRotationStatement{rotate(t, old.sign, old, next)}}

	vaultID := uuid.New()
	fixture.store.slots[slotKey(vaultID, 1)] = oldID

	replace := func(request *vaultsyncv1.ReplaceEscrowSlotRequest) error {
		_, err := fixture.client().ReplaceEscrowSlot(t.Context(), withAuthorization(request, "Bearer "+jobToken))

		return err
	}

	valid := func() *vaultsyncv1.ReplaceEscrowSlotRequest {
		return &vaultsyncv1.ReplaceEscrowSlotRequest{VaultId: vaultID.String(), Epoch: 1, OldRecipientId: oldID, NewRecipientId: nextID, WrappedKey: []byte{1}}
	}

	for name, mutate := range map[string]func(*vaultsyncv1.ReplaceEscrowSlotRequest){
		"a new key that is not the head": func(request *vaultsyncv1.ReplaceEscrowSlotRequest) {
			request.NewRecipientId = "sha256:" + strings.Repeat("0", 64)
		},
		"the same key":   func(request *vaultsyncv1.ReplaceEscrowSlotRequest) { request.OldRecipientId = nextID },
		"no wrapped key": func(request *vaultsyncv1.ReplaceEscrowSlotRequest) { request.WrappedKey = nil },
		"a wrapped key one byte too long": func(request *vaultsyncv1.ReplaceEscrowSlotRequest) {
			request.WrappedKey = make([]byte, api.MaxWrappedKeyBytes+1)
		},
		"epoch zero":        func(request *vaultsyncv1.ReplaceEscrowSlotRequest) { request.Epoch = 0 },
		"a malformed vault": func(request *vaultsyncv1.ReplaceEscrowSlotRequest) { request.VaultId = "vault" },
		"no old key":        func(request *vaultsyncv1.ReplaceEscrowSlotRequest) { request.OldRecipientId = "" },
	} {
		request := valid()
		mutate(request)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(replace(request)), name)
	}

	assert.Equal(t, oldID, fixture.store.slots[slotKey(vaultID, 1)], "nothing refused is replaced")

	largest := valid()
	largest.WrappedKey = make([]byte, api.MaxWrappedKeyBytes)
	require.NoError(t, replace(largest))
	assert.Equal(t, nextID, fixture.store.slots[slotKey(vaultID, 1)])

	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(replace(valid())), "the old slot is gone")
}
