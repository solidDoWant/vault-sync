package api_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"log/slog"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// userKeyRecorder records what reaches the store; out-of-bounds input must
// be refused before any call.
type userKeyRecorder struct {
	calls             int
	authKeyHash       []byte
	wrapping          store.Wrapping
	publicKey         []byte
	expectedPublicKey []byte
}

func (recorder *userKeyRecorder) CreateUserKey(_ context.Context, _ uuid.UUID, publicKey []byte, wrapping store.Wrapping) error {
	recorder.calls++
	recorder.publicKey = publicKey
	recorder.wrapping = wrapping

	return nil
}

func (recorder *userKeyRecorder) UserKeyParams(context.Context, uuid.UUID) (store.UserKey, error) {
	recorder.calls++

	return store.UserKey{}, nil
}

func (recorder *userKeyRecorder) UnlockUserKey(_ context.Context, _ uuid.UUID, authKeyHash []byte, _ store.AttemptLimit) (store.UserKey, error) {
	recorder.calls++
	recorder.authKeyHash = authKeyHash

	return store.UserKey{}, nil
}

func (recorder *userKeyRecorder) ChangePassphrase(_ context.Context, _ uuid.UUID, authKeyHash, expectedPublicKey []byte, replacement store.Wrapping, _ store.AttemptLimit) error {
	recorder.calls++
	recorder.authKeyHash = authKeyHash
	recorder.expectedPublicKey = expectedPublicKey
	recorder.wrapping = replacement

	return nil
}

func (recorder *userKeyRecorder) AnchorList(context.Context, uuid.UUID) (store.AnchorList, error) {
	recorder.calls++

	return store.AnchorList{}, nil
}

func (recorder *userKeyRecorder) PutAnchorList(context.Context, uuid.UUID, uint64, []byte) error {
	recorder.calls++

	return nil
}

func validParams() *vaultsyncv1.PassphraseParams {
	return &vaultsyncv1.PassphraseParams{
		Suite: 2, MemoryKib: 65536, Iterations: 3, Parallelism: 1, Salt: bytes.Repeat([]byte{7}, 16),
	}
}

// paramsCases are the bounds of SPEC.md §9.3, written out here rather than
// taken from the implementation: each value just inside a bound is accepted
// and each value just outside is refused.
func paramsCases() []struct {
	name     string
	mutate   func(*vaultsyncv1.PassphraseParams)
	accepted bool
} {
	return []struct {
		name     string
		mutate   func(*vaultsyncv1.PassphraseParams)
		accepted bool
	}{
		{name: "defaults", mutate: func(*vaultsyncv1.PassphraseParams) {}, accepted: true},
		{name: "suite 0", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Suite = 0 }},
		{name: "suite 1", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Suite = 1 }},
		{name: "suite 3", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Suite = 3 }},
		{name: "memory 19456 KiB", mutate: func(params *vaultsyncv1.PassphraseParams) { params.MemoryKib = 19456 }, accepted: true},
		{name: "memory 19455 KiB", mutate: func(params *vaultsyncv1.PassphraseParams) { params.MemoryKib = 19455 }},
		{name: "memory 131072 KiB", mutate: func(params *vaultsyncv1.PassphraseParams) { params.MemoryKib = 131072 }, accepted: true},
		{name: "memory 131073 KiB", mutate: func(params *vaultsyncv1.PassphraseParams) { params.MemoryKib = 131073 }},
		{name: "2 passes", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Iterations = 2 }, accepted: true},
		{name: "1 pass", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Iterations = 1 }},
		{name: "8 passes", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Iterations = 8 }, accepted: true},
		{name: "9 passes", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Iterations = 9 }},
		{name: "0 lanes", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Parallelism = 0 }},
		{name: "4 lanes", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Parallelism = 4 }, accepted: true},
		{name: "5 lanes", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Parallelism = 5 }},
		{name: "15-byte salt", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Salt = params.Salt[:15] }},
		{name: "17-byte salt", mutate: func(params *vaultsyncv1.PassphraseParams) { params.Salt = append(params.Salt, 0) }},
	}
}

func userKeyContext(t *testing.T) context.Context {
	t.Helper()

	return auth.WithUser(t.Context(), auth.User{ID: uuid.New(), Identity: auth.Identity{Issuer: "https://issuer.example", Subject: "alice"}})
}

func validCreateRequest() *vaultsyncv1.CreateUserKeyRequest {
	return &vaultsyncv1.CreateUserKeyRequest{
		PublicKey:         bytes.Repeat([]byte{1}, 1216),
		WrappedPrivateKey: bytes.Repeat([]byte{2}, 98),
		Params:            validParams(),
		AuthKey:           bytes.Repeat([]byte{3}, 32),
	}
}

func validChangeRequest() *vaultsyncv1.ChangePassphraseRequest {
	return &vaultsyncv1.ChangePassphraseRequest{
		AuthKey:              bytes.Repeat([]byte{3}, 32),
		PublicKey:            bytes.Repeat([]byte{1}, 1216),
		NewWrappedPrivateKey: bytes.Repeat([]byte{4}, 98),
		NewParams:            validParams(),
		NewAuthKey:           bytes.Repeat([]byte{5}, 32),
	}
}

func assertBounded(t *testing.T, recorder *userKeyRecorder, err error, accepted bool) {
	t.Helper()

	if accepted {
		require.NoError(t, err)
		assert.Equal(t, 1, recorder.calls, "accepted input reaches the store")

		return
	}

	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	assert.Zero(t, recorder.calls, "refused before the store is touched")
}

func TestCreateUserKeyBoundsEveryInputBeforeTheStore(t *testing.T) {
	ctx := userKeyContext(t)

	tests := []struct {
		name     string
		mutate   func(*vaultsyncv1.CreateUserKeyRequest)
		accepted bool
	}{
		{name: "1215-byte public key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.PublicKey = request.PublicKey[:1215] }},
		{name: "32-byte (X25519) public key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.PublicKey = request.PublicKey[:32] }},
		{name: "1217-byte public key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.PublicKey = append(request.PublicKey, 0) }},
		{name: "empty public key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.PublicKey = nil }},
		{name: "empty wrapped key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.WrappedPrivateKey = nil }},
		{name: "1-byte wrapped key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.WrappedPrivateKey = []byte{1} }, accepted: true},
		{name: "256-byte wrapped key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) {
			request.WrappedPrivateKey = make([]byte, 256)
		}, accepted: true},
		{name: "257-byte wrapped key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.WrappedPrivateKey = make([]byte, 257) }},
		{name: "31-byte auth key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.AuthKey = request.AuthKey[:31] }},
		{name: "33-byte auth key", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.AuthKey = append(request.AuthKey, 0) }},
		{name: "missing params", mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { request.Params = nil }},
	}

	for _, params := range paramsCases() {
		tests = append(tests, struct {
			name     string
			mutate   func(*vaultsyncv1.CreateUserKeyRequest)
			accepted bool
		}{name: "params " + params.name, mutate: func(request *vaultsyncv1.CreateUserKeyRequest) { params.mutate(request.Params) }, accepted: params.accepted})
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := &userKeyRecorder{}
			service := api.UserKeyService{Store: recorder, Logger: slog.New(slog.DiscardHandler)}
			request := validCreateRequest()
			test.mutate(request)

			_, err := service.CreateUserKey(ctx, connect.NewRequest(request))
			assertBounded(t, recorder, err, test.accepted)
		})
	}
}

func TestChangePassphraseBoundsEveryInputBeforeTheStore(t *testing.T) {
	ctx := userKeyContext(t)

	tests := []struct {
		name     string
		mutate   func(*vaultsyncv1.ChangePassphraseRequest)
		accepted bool
	}{
		{name: "valid", mutate: func(*vaultsyncv1.ChangePassphraseRequest) {}, accepted: true},
		{name: "31-byte auth key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { request.AuthKey = request.AuthKey[:31] }},
		{name: "33-byte auth key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { request.AuthKey = append(request.AuthKey, 0) }},
		{name: "1215-byte public key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { request.PublicKey = request.PublicKey[:1215] }},
		{name: "32-byte (X25519) public key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { request.PublicKey = request.PublicKey[:32] }},
		{name: "1217-byte public key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { request.PublicKey = append(request.PublicKey, 0) }},
		{name: "empty new wrapped key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { request.NewWrappedPrivateKey = nil }},
		{name: "256-byte new wrapped key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) {
			request.NewWrappedPrivateKey = make([]byte, 256)
		}, accepted: true},
		{name: "257-byte new wrapped key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) {
			request.NewWrappedPrivateKey = make([]byte, 257)
		}},
		{name: "31-byte new auth key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { request.NewAuthKey = request.NewAuthKey[:31] }},
		{name: "33-byte new auth key", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { request.NewAuthKey = append(request.NewAuthKey, 0) }},
		{name: "missing new params", mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { request.NewParams = nil }},
	}

	for _, params := range paramsCases() {
		tests = append(tests, struct {
			name     string
			mutate   func(*vaultsyncv1.ChangePassphraseRequest)
			accepted bool
		}{name: "new params " + params.name, mutate: func(request *vaultsyncv1.ChangePassphraseRequest) { params.mutate(request.NewParams) }, accepted: params.accepted})
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := &userKeyRecorder{}
			service := api.UserKeyService{Store: recorder, Logger: slog.New(slog.DiscardHandler)}
			request := validChangeRequest()
			test.mutate(request)

			_, err := service.ChangePassphrase(ctx, connect.NewRequest(request))
			assertBounded(t, recorder, err, test.accepted)
		})
	}
}

func TestUnlockUserKeyBoundsTheAuthKeyBeforeTheStore(t *testing.T) {
	ctx := userKeyContext(t)

	for size, accepted := range map[int]bool{0: false, 31: false, 32: true, 33: false} {
		recorder := &userKeyRecorder{}
		service := api.UserKeyService{Store: recorder, Logger: slog.New(slog.DiscardHandler)}

		_, err := service.UnlockUserKey(ctx, connect.NewRequest(&vaultsyncv1.UnlockUserKeyRequest{AuthKey: make([]byte, size)}))
		assertBounded(t, recorder, err, accepted)
	}
}

// The store only ever sees SHA-256 of an auth_key, never the auth_key.
func TestOnlyTheHashOfAnAuthKeyReachesTheStore(t *testing.T) {
	ctx := userKeyContext(t)
	recorder := &userKeyRecorder{}
	service := api.UserKeyService{Store: recorder, Logger: slog.New(slog.DiscardHandler)}

	create := validCreateRequest()
	_, err := service.CreateUserKey(ctx, connect.NewRequest(proto.Clone(create).(*vaultsyncv1.CreateUserKeyRequest)))
	require.NoError(t, err)

	createHash := sha256.Sum256(create.GetAuthKey())
	assert.Equal(t, createHash[:], recorder.wrapping.AuthKeyHash)
	assert.Equal(t, create.GetPublicKey(), recorder.publicKey)

	change := validChangeRequest()
	_, err = service.ChangePassphrase(ctx, connect.NewRequest(change))
	require.NoError(t, err)

	currentHash := sha256.Sum256(change.GetAuthKey())
	newHash := sha256.Sum256(change.GetNewAuthKey())

	assert.Equal(t, currentHash[:], recorder.authKeyHash)
	assert.Equal(t, newHash[:], recorder.wrapping.AuthKeyHash)
	assert.Equal(t, change.GetPublicKey(), recorder.expectedPublicKey)

	unlockKey := bytes.Repeat([]byte{9}, 32)
	_, err = service.UnlockUserKey(ctx, connect.NewRequest(&vaultsyncv1.UnlockUserKeyRequest{AuthKey: unlockKey}))
	require.NoError(t, err)

	unlockHash := sha256.Sum256(unlockKey)
	assert.Equal(t, unlockHash[:], recorder.authKeyHash)
}

// Every user-key response names the caller's own server user id, the id a
// signed log entry must name, and only that caller's.
func TestUserKeyResponsesNameTheCallersUserID(t *testing.T) {
	service := api.UserKeyService{Store: &userKeyRecorder{}, Logger: slog.New(slog.DiscardHandler)}

	callers := []auth.User{
		{ID: uuid.MustParse("0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b"), Identity: auth.Identity{Issuer: "https://issuer.example", Subject: "alice"}},
		{ID: uuid.MustParse("0192a3b4-c5d6-7e8f-9a0b-ffffffffffff"), Identity: auth.Identity{Issuer: "https://issuer.example", Subject: "bob"}},
	}

	for _, caller := range callers {
		t.Run(caller.Identity.Subject, func(t *testing.T) {
			ctx := auth.WithUser(t.Context(), caller)
			want := caller.ID.String()

			params, err := service.GetUserKeyParams(ctx, connect.NewRequest(&vaultsyncv1.GetUserKeyParamsRequest{}))
			require.NoError(t, err)
			assert.Equal(t, want, params.Msg.GetUserId())

			created, err := service.CreateUserKey(ctx, connect.NewRequest(validCreateRequest()))
			require.NoError(t, err)
			assert.Equal(t, want, created.Msg.GetUserId())

			unlocked, err := service.UnlockUserKey(ctx, connect.NewRequest(&vaultsyncv1.UnlockUserKeyRequest{AuthKey: bytes.Repeat([]byte{9}, 32)}))
			require.NoError(t, err)
			assert.Equal(t, want, unlocked.Msg.GetUserId())
		})
	}
}
