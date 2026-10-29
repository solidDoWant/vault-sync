package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// User key bounds (SPEC.md §9.3).
const (
	// AuthKeyBytes is the size of an auth_key.
	AuthKeyBytes = 32
	// UserPublicKeyBytes is the size of a user's hybrid ML-KEM-768 + X25519
	// public key.
	UserPublicKeyBytes = e2ee.PublicKeySize
	// MaxWrappedPrivateKeyBytes bounds a wrapped private key. A suite 2
	// wrapping of a 32-byte hybrid private key seed is 98 bytes.
	MaxWrappedPrivateKeyBytes = 256
	// MaxFailedUnlockAttempts is how many wrong auth_keys a user may present
	// within FailedUnlockWindow before every attempt is refused until the
	// window ends.
	MaxFailedUnlockAttempts = 10
	// FailedUnlockWindow is the window of MaxFailedUnlockAttempts, starting
	// at the first failure counted in it.
	FailedUnlockWindow = time.Hour
)

// UserKeyStore persists users' wrapped keys. *store.Store implements it.
type UserKeyStore interface {
	CreateUserKey(ctx context.Context, userID uuid.UUID, publicKey []byte, wrapping store.Wrapping) error
	UserKeyParams(ctx context.Context, userID uuid.UUID) (store.UserKey, error)
	UnlockUserKey(ctx context.Context, userID uuid.UUID, authKeyHash []byte, limit store.AttemptLimit) (store.UserKey, error)
	ChangePassphrase(ctx context.Context, userID uuid.UUID, authKeyHash, expectedPublicKey []byte, replacement store.Wrapping, limit store.AttemptLimit) error
}

// UserKeyService implements vaultsync.v1.UserKeyService for the
// authenticated caller's own key. It never logs auth_key or key material.
type UserKeyService struct {
	Store UserKeyStore
	// Logger receives internal errors, which are not returned to callers.
	Logger *slog.Logger
}

var _ vaultsyncv1connect.UserKeyServiceHandler = UserKeyService{}

var attemptLimit = store.AttemptLimit{Max: MaxFailedUnlockAttempts, Window: FailedUnlockWindow}

// GetUserKeyParams returns the caller's public key and wrapping parameters.
func (service UserKeyService) GetUserKeyParams(ctx context.Context, _ *connect.Request[vaultsyncv1.GetUserKeyParamsRequest]) (*connect.Response[vaultsyncv1.GetUserKeyParamsResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	key, err := service.Store.UserKeyParams(ctx, user.ID)
	if err != nil {
		return nil, service.storeError(ctx, "cannot read user key", err)
	}

	return connect.NewResponse(&vaultsyncv1.GetUserKeyParamsResponse{
		PublicKey: key.PublicKey,
		Params:    paramsMessage(key.Params),
	}), nil
}

// CreateUserKey stores the caller's key pair, once.
func (service UserKeyService) CreateUserKey(ctx context.Context, request *connect.Request[vaultsyncv1.CreateUserKeyRequest]) (*connect.Response[vaultsyncv1.CreateUserKeyResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	message := request.Msg
	if err := checkPublicKey("public_key", message.GetPublicKey()); err != nil {
		return nil, err
	}

	wrapping, err := checkWrapping("", message.GetWrappedPrivateKey(), message.GetParams(), message.GetAuthKey())
	if err != nil {
		return nil, err
	}

	if err := service.Store.CreateUserKey(ctx, user.ID, message.GetPublicKey(), wrapping); err != nil {
		if errors.Is(err, store.ErrUserKeyExists) {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("a user key already exists"))
		}

		return nil, service.storeError(ctx, "cannot create user key", err)
	}

	return connect.NewResponse(&vaultsyncv1.CreateUserKeyResponse{}), nil
}

// UnlockUserKey releases the caller's wrapped key for the right auth_key.
func (service UserKeyService) UnlockUserKey(ctx context.Context, request *connect.Request[vaultsyncv1.UnlockUserKeyRequest]) (*connect.Response[vaultsyncv1.UnlockUserKeyResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	authKeyHash, err := hashAuthKey("auth_key", request.Msg.GetAuthKey())
	if err != nil {
		return nil, err
	}

	key, err := service.Store.UnlockUserKey(ctx, user.ID, authKeyHash, attemptLimit)
	if err != nil {
		return nil, service.storeError(ctx, "cannot unlock user key", err)
	}

	return connect.NewResponse(&vaultsyncv1.UnlockUserKeyResponse{
		PublicKey:         key.PublicKey,
		WrappedPrivateKey: key.WrappedPrivateKey,
		Params:            paramsMessage(key.Params),
	}), nil
}

// ChangePassphrase re-wraps the caller's private key.
func (service UserKeyService) ChangePassphrase(ctx context.Context, request *connect.Request[vaultsyncv1.ChangePassphraseRequest]) (*connect.Response[vaultsyncv1.ChangePassphraseResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	message := request.Msg

	authKeyHash, err := hashAuthKey("auth_key", message.GetAuthKey())
	if err != nil {
		return nil, err
	}

	if err := checkPublicKey("public_key", message.GetPublicKey()); err != nil {
		return nil, err
	}

	replacement, err := checkWrapping("new_", message.GetNewWrappedPrivateKey(), message.GetNewParams(), message.GetNewAuthKey())
	if err != nil {
		return nil, err
	}

	err = service.Store.ChangePassphrase(ctx, user.ID, authKeyHash, message.GetPublicKey(), replacement, attemptLimit)
	if err != nil {
		if errors.Is(err, store.ErrPublicKeyMismatch) {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("public_key is not the stored public key"))
		}

		return nil, service.storeError(ctx, "cannot change passphrase", err)
	}

	return connect.NewResponse(&vaultsyncv1.ChangePassphraseResponse{}), nil
}

// storeError maps the store errors shared by the procedures; anything else
// is logged and returned as INTERNAL with message.
func (service UserKeyService) storeError(ctx context.Context, message string, err error) error {
	var exhausted *store.AttemptsExhaustedError

	switch {
	case errors.Is(err, store.ErrUserKeyNotFound):
		return connect.NewError(connect.CodeNotFound, errors.New("no user key"))
	case errors.Is(err, store.ErrWrongAuthKey):
		return ReasonError(connect.CodePermissionDenied, vaultsyncv1.ErrorReason_ERROR_REASON_WRONG_PASSPHRASE,
			errors.New("wrong passphrase"))
	case errors.As(err, &exhausted):
		connectErr := connect.NewError(connect.CodeResourceExhausted,
			fmt.Errorf("too many wrong passphrases; retry after %s", exhausted.RetryAt.UTC().Format(time.RFC3339)))

		// NewErrorDetail only fails for a message that cannot be
		// marshaled, which ErrorDetail always can.
		if detail, detailErr := connect.NewErrorDetail(&vaultsyncv1.ErrorDetail{
			Reason:    vaultsyncv1.ErrorReason_ERROR_REASON_PASSPHRASE_ATTEMPTS_EXHAUSTED,
			RetryTime: timestamppb.New(exhausted.RetryAt),
		}); detailErr == nil {
			connectErr.AddDetail(detail)
		}

		return connectErr
	}

	service.Logger.ErrorContext(ctx, message, "error", err)

	return connect.NewError(connect.CodeInternal, errors.New(message))
}

func checkPublicKey(field string, publicKey []byte) error {
	if len(publicKey) != UserPublicKeyBytes {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s must be exactly %d bytes", field, UserPublicKeyBytes))
	}

	return nil
}

func hashAuthKey(field string, authKey []byte) ([]byte, error) {
	if len(authKey) != AuthKeyBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s must be exactly %d bytes", field, AuthKeyBytes))
	}

	sum := sha256.Sum256(authKey)

	return sum[:], nil
}

// checkWrapping bounds a wrapping's fields, named with prefix, and returns
// it with auth_key replaced by its hash.
func checkWrapping(prefix string, wrapped []byte, params *vaultsyncv1.PassphraseParams, authKey []byte) (store.Wrapping, error) {
	if len(wrapped) == 0 || len(wrapped) > MaxWrappedPrivateKeyBytes {
		return store.Wrapping{}, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("%swrapped_private_key must be 1 to %d bytes", prefix, MaxWrappedPrivateKeyBytes))
	}

	if err := checkParams(prefix+"params", params); err != nil {
		return store.Wrapping{}, err
	}

	authKeyHash, err := hashAuthKey(prefix+"auth_key", authKey)
	if err != nil {
		return store.Wrapping{}, err
	}

	return store.Wrapping{
		WrappedPrivateKey: wrapped,
		Params: store.PassphraseParams{
			Suite:       params.GetSuite(),
			MemoryKiB:   params.GetMemoryKib(),
			Iterations:  params.GetIterations(),
			Parallelism: params.GetParallelism(),
			Salt:        params.GetSalt(),
		},
		AuthKeyHash: authKeyHash,
	}, nil
}

func checkParams(field string, params *vaultsyncv1.PassphraseParams) error {
	invalid := func(format string, args ...any) error {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(field+"."+format, args...))
	}

	switch {
	case params.GetSuite() != uint32(e2ee.SuiteV2):
		return invalid("suite must be %d", e2ee.SuiteV2)
	case params.GetMemoryKib() < e2ee.MinArgon2Memory || params.GetMemoryKib() > e2ee.MaxArgon2Memory:
		return invalid("memory_kib must be %d to %d", e2ee.MinArgon2Memory, e2ee.MaxArgon2Memory)
	case params.GetIterations() < e2ee.MinArgon2Iterations || params.GetIterations() > e2ee.MaxArgon2Iterations:
		return invalid("iterations must be %d to %d", e2ee.MinArgon2Iterations, e2ee.MaxArgon2Iterations)
	case params.GetParallelism() < e2ee.MinArgon2Parallelism || params.GetParallelism() > e2ee.MaxArgon2Parallelism:
		return invalid("parallelism must be %d to %d", e2ee.MinArgon2Parallelism, e2ee.MaxArgon2Parallelism)
	case len(params.GetSalt()) != e2ee.SaltSize:
		return invalid("salt must be exactly %d bytes", e2ee.SaltSize)
	}

	return nil
}

func paramsMessage(params store.PassphraseParams) *vaultsyncv1.PassphraseParams {
	return &vaultsyncv1.PassphraseParams{
		Suite:       params.Suite,
		MemoryKib:   params.MemoryKiB,
		Iterations:  params.Iterations,
		Parallelism: params.Parallelism,
		Salt:        params.Salt,
	}
}
