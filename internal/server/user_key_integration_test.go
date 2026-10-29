//go:build integration

package server_test

import (
	"bytes"
	"encoding/hex"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/argon2"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

// Issue #665: user key storage and passphrase-gated release.

// The failed-attempt limit, written out rather than read from the
// implementation (SPEC.md §9.3).
const (
	unlockAttempts = 10
	unlockWindow   = time.Hour
)

func (fixture *syncFixture) userKeys(replica int) vaultsyncv1connect.UserKeyServiceClient {
	return vaultsyncv1connect.NewUserKeyServiceClient(http.DefaultClient, fixture.replicas[replica%len(fixture.replicas)].apiURL())
}

// userKeyMaterial is what a device sends for one wrapping. The wrapped key
// and auth_key are random: the server treats them as opaque bytes.
type userKeyMaterial struct {
	publicKey []byte
	wrapped   []byte
	params    *vaultsyncv1.PassphraseParams
	authKey   []byte
}

func newUserKeyMaterial(t *testing.T) userKeyMaterial {
	t.Helper()

	return userKeyMaterial{
		publicKey: randomBytes(t, 1216),
		wrapped:   randomBytes(t, 98),
		params: &vaultsyncv1.PassphraseParams{
			Suite: 2, MemoryKib: 65536, Iterations: 3, Parallelism: 1, Salt: randomBytes(t, 16),
		},
		authKey: randomBytes(t, 32),
	}
}

// rewrapped is material for a new passphrase over the same key pair.
func (material userKeyMaterial) rewrapped(t *testing.T) userKeyMaterial {
	t.Helper()

	next := newUserKeyMaterial(t)
	next.publicKey = material.publicKey
	next.params.Iterations = 4

	return next
}

func (fixture *syncFixture) createUserKey(t *testing.T, token string, material userKeyMaterial) error {
	t.Helper()

	_, err := fixture.userKeys(0).CreateUserKey(t.Context(), authorized(&vaultsyncv1.CreateUserKeyRequest{
		PublicKey: material.publicKey, WrappedPrivateKey: material.wrapped, Params: material.params, AuthKey: material.authKey,
	}, token))

	return err
}

func (fixture *syncFixture) unlockUserKey(t *testing.T, replica int, token string, authKey []byte) (*vaultsyncv1.UnlockUserKeyResponse, error) {
	t.Helper()

	response, err := fixture.userKeys(replica).UnlockUserKey(t.Context(), authorized(&vaultsyncv1.UnlockUserKeyRequest{AuthKey: authKey}, token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

func (fixture *syncFixture) changePassphrase(t *testing.T, replica int, token string, authKey, publicKey []byte, next userKeyMaterial) error {
	t.Helper()

	_, err := fixture.userKeys(replica).ChangePassphrase(t.Context(), authorized(&vaultsyncv1.ChangePassphraseRequest{
		AuthKey: authKey, PublicKey: publicKey,
		NewWrappedPrivateKey: next.wrapped, NewParams: next.params, NewAuthKey: next.authKey,
	}, token))

	return err
}

// requireUnlocksTo asserts authKey releases exactly material's wrapping.
func (fixture *syncFixture) requireUnlocksTo(t *testing.T, token string, authKey []byte, material userKeyMaterial) {
	t.Helper()

	unlocked, err := fixture.unlockUserKey(t, 0, token, authKey)
	require.NoError(t, err)
	assert.Equal(t, material.publicKey, unlocked.GetPublicKey())
	assert.Equal(t, material.wrapped, unlocked.GetWrappedPrivateKey())
	assert.Equal(t, material.params.GetSalt(), unlocked.GetParams().GetSalt())
	assert.Equal(t, material.params.GetIterations(), unlocked.GetParams().GetIterations())
}

func requireWrongPassphrase(t *testing.T, err error) {
	t.Helper()

	require.Error(t, err)
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), err)
	assert.Equal(t, vaultsyncv1.ErrorReason_ERROR_REASON_WRONG_PASSPHRASE, api.ErrorReasonOf(err))
}

// requireExhausted asserts err refuses the attempt for too many failures
// and returns the retry time it names.
func requireExhausted(t *testing.T, err error) time.Time {
	t.Helper()

	require.Error(t, err)
	require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err), err)

	var connectErr *connect.Error
	require.ErrorAs(t, err, &connectErr)

	for _, detail := range connectErr.Details() {
		value, valueErr := detail.Value()
		require.NoError(t, valueErr)

		if reason, ok := value.(*vaultsyncv1.ErrorDetail); ok {
			assert.Equal(t, vaultsyncv1.ErrorReason_ERROR_REASON_PASSPHRASE_ATTEMPTS_EXHAUSTED, reason.GetReason())
			require.NotNil(t, reason.GetRetryTime(), "a retry time is given")

			return reason.GetRetryTime().AsTime()
		}
	}

	require.Fail(t, "no ErrorDetail")

	return time.Time{}
}

// ageAttemptWindow moves the caller's failed-attempt window into the past
// by age, as if that much time had passed.
func (fixture *syncFixture) ageAttemptWindow(t *testing.T, subject string, age time.Duration) {
	t.Helper()

	tag, err := fixture.pool.Exec(t.Context(),
		`UPDATE user_keys SET attempt_window_start = attempt_window_start - make_interval(secs => $2) WHERE user_id = $1`,
		userID(t, fixture.pool, fixture.issuer.URL, subject), age.Seconds())
	require.NoError(t, err)
	require.EqualValues(t, 1, tag.RowsAffected())
}

// Criterion 1: CreateUserKey stores a key once; a second call is
// ALREADY_EXISTS and changes nothing.
func TestCreateUserKeyIsCreateOnlyAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")

	_, err := fixture.userKeys(0).GetUserKeyParams(t.Context(), authorized(&vaultsyncv1.GetUserKeyParamsRequest{}, token))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "no key yet")

	first := newUserKeyMaterial(t)
	require.NoError(t, fixture.createUserKey(t, token, first))

	params, err := fixture.userKeys(1).GetUserKeyParams(t.Context(), authorized(&vaultsyncv1.GetUserKeyParamsRequest{}, token))
	require.NoError(t, err)
	assert.Equal(t, first.publicKey, params.Msg.GetPublicKey())
	assert.Equal(t, first.params.GetSalt(), params.Msg.GetParams().GetSalt())
	assert.Equal(t, first.params.GetMemoryKib(), params.Msg.GetParams().GetMemoryKib())
	assert.Equal(t, first.params.GetIterations(), params.Msg.GetParams().GetIterations())
	assert.Equal(t, first.params.GetParallelism(), params.Msg.GetParams().GetParallelism())
	assert.Equal(t, first.params.GetSuite(), params.Msg.GetParams().GetSuite())

	second := newUserKeyMaterial(t)
	err = fixture.createUserKey(t, token, second)
	assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err), err)

	// Concurrent creates on both replicas cannot replace it either.
	var group sync.WaitGroup
	for replica := range 2 {
		group.Go(func() {
			_, err := fixture.userKeys(replica).CreateUserKey(t.Context(), authorized(&vaultsyncv1.CreateUserKeyRequest{
				PublicKey: second.publicKey, WrappedPrivateKey: second.wrapped, Params: second.params, AuthKey: second.authKey,
			}, token))
			assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err), err)
		})
	}

	group.Wait()

	fixture.requireUnlocksTo(t, token, first.authKey, first)

	_, err = fixture.unlockUserKey(t, 0, token, second.authKey)
	requireWrongPassphrase(t, err)
}

// Criterion 1, concurrently: of two devices enabling encryption at once on
// two replicas, exactly one key is stored.
func TestConcurrentCreateUserKeyStoresOneKeyAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")

	materials := []userKeyMaterial{newUserKeyMaterial(t), newUserKeyMaterial(t)}
	results := make([]error, len(materials))

	var group sync.WaitGroup
	for index, material := range materials {
		group.Go(func() {
			_, results[index] = fixture.userKeys(index).CreateUserKey(t.Context(), authorized(&vaultsyncv1.CreateUserKeyRequest{
				PublicKey: material.publicKey, WrappedPrivateKey: material.wrapped, Params: material.params, AuthKey: material.authKey,
			}, token))
		})
	}

	group.Wait()

	var winners []int

	for index, err := range results {
		if err == nil {
			winners = append(winners, index)

			continue
		}

		assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err), err)
	}

	require.Len(t, winners, 1)
	fixture.requireUnlocksTo(t, token, materials[winners[0]].authKey, materials[winners[0]])
}

// Criterion 2: the right auth_key releases the wrapped key; a wrong one
// gets an error and no key material.
func TestUnlockUserKeyReleasesTheKeyOnlyForTheRightAuthKeyAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")

	_, err := fixture.unlockUserKey(t, 0, token, randomBytes(t, 32))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "no key yet")

	material := newUserKeyMaterial(t)
	require.NoError(t, fixture.createUserKey(t, token, material))

	fixture.requireUnlocksTo(t, token, material.authKey, material)

	wrong := bytes.Clone(material.authKey)
	wrong[0] ^= 1
	response, err := fixture.unlockUserKey(t, 1, token, wrong)
	requireWrongPassphrase(t, err)
	assert.Nil(t, response)
	assert.NotContains(t, err.Error(), hex.EncodeToString(material.wrapped))
}

// Criterion 3: after exactly unlockAttempts wrong auth_keys, alternating
// replicas, the next attempt is refused with a retry time even with the
// right auth_key, until the window ends.
func TestFailedUnlockAttemptsAreLimitedOnEveryReplicaAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")
	material := newUserKeyMaterial(t)
	require.NoError(t, fixture.createUserKey(t, token, material))

	start := time.Now()

	for attempt := range unlockAttempts - 1 {
		_, err := fixture.unlockUserKey(t, attempt, token, randomBytes(t, 32))
		requireWrongPassphrase(t, err)
	}

	// N-1 failures: the right auth_key still works, and does not reset the
	// count.
	fixture.requireUnlocksTo(t, token, material.authKey, material)

	_, err := fixture.unlockUserKey(t, 1, token, randomBytes(t, 32))
	requireWrongPassphrase(t, err)

	// Attempt N+1, on either replica, with the right auth_key.
	for replica := range 2 {
		response, err := fixture.unlockUserKey(t, replica, token, material.authKey)
		retryAt := requireExhausted(t, err)
		assert.Nil(t, response)
		assert.WithinDuration(t, start.Add(unlockWindow), retryAt, time.Minute)

		// ChangePassphrase is refused alike.
		retryAt = requireExhausted(t, fixture.changePassphrase(t, replica, token, material.authKey, material.publicKey, material.rewrapped(t)))
		assert.WithinDuration(t, start.Add(unlockWindow), retryAt, time.Minute)
	}

	// Refused attempts are not counted and do not extend the window: one
	// minute before its end it still holds...
	fixture.ageAttemptWindow(t, "alice", unlockWindow-time.Minute)
	requireExhausted(t, fixture.unlockUserKeyErr(t, 0, token, material.authKey))

	// ...and once it has ended the right auth_key works again.
	fixture.ageAttemptWindow(t, "alice", time.Minute)
	fixture.requireUnlocksTo(t, token, material.authKey, material)

	// A new window starts with the next failure, with a full allowance.
	for attempt := range unlockAttempts {
		_, err := fixture.unlockUserKey(t, attempt, token, randomBytes(t, 32))
		requireWrongPassphrase(t, err)
	}

	requireExhausted(t, fixture.unlockUserKeyErr(t, 0, token, material.authKey))
}

func (fixture *syncFixture) unlockUserKeyErr(t *testing.T, replica int, token string, authKey []byte) error {
	t.Helper()

	_, err := fixture.unlockUserKey(t, replica, token, authKey)

	return err
}

// Criterion 3, concurrently: wrong attempts racing on two replicas (two
// pools on one database) share one count, so exactly unlockAttempts of them
// are checked.
func TestConcurrentFailedUnlockAttemptsShareOneCountAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")
	material := newUserKeyMaterial(t)
	require.NoError(t, fixture.createUserKey(t, token, material))

	const attempts = 2 * unlockAttempts

	results := make([]error, attempts)

	var group sync.WaitGroup
	for attempt := range attempts {
		group.Go(func() {
			results[attempt] = fixture.unlockUserKeyErr(t, attempt, token, randomBytes(t, 32))
		})
	}

	group.Wait()

	counts := map[connect.Code]int{}
	for _, err := range results {
		counts[connect.CodeOf(err)]++
	}

	assert.Equal(t, map[connect.Code]int{
		connect.CodePermissionDenied:  unlockAttempts,
		connect.CodeResourceExhausted: attempts - unlockAttempts,
	}, counts)

	requireExhausted(t, fixture.unlockUserKeyErr(t, 1, token, material.authKey))
}

// Criterion 4: a passphrase change with the current auth_key and the stored
// public key replaces the wrapping and the verifier together.
func TestChangePassphraseReplacesTheWrappingAtomicallyAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")
	material := newUserKeyMaterial(t)
	require.NoError(t, fixture.createUserKey(t, token, material))

	next := material.rewrapped(t)
	require.NoError(t, fixture.changePassphrase(t, 1, token, material.authKey, material.publicKey, next))

	fixture.requireUnlocksTo(t, token, next.authKey, next)

	_, err := fixture.unlockUserKey(t, 0, token, material.authKey)
	requireWrongPassphrase(t, err)

	params, err := fixture.userKeys(0).GetUserKeyParams(t.Context(), authorized(&vaultsyncv1.GetUserKeyParamsRequest{}, token))
	require.NoError(t, err)
	assert.Equal(t, next.params.GetSalt(), params.Msg.GetParams().GetSalt())
	assert.Equal(t, material.publicKey, params.Msg.GetPublicKey())
}

// Criterion 4: a public key that does not match changes nothing, even with
// the right auth_key.
func TestChangePassphraseIsACompareAndSwapOnThePublicKeyAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")
	material := newUserKeyMaterial(t)
	require.NoError(t, fixture.createUserKey(t, token, material))

	next := newUserKeyMaterial(t) // another key pair
	err := fixture.changePassphrase(t, 0, token, material.authKey, next.publicKey, next)
	assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), err)

	fixture.requireUnlocksTo(t, token, material.authKey, material)

	_, err = fixture.unlockUserKey(t, 0, token, next.authKey)
	requireWrongPassphrase(t, err)
}

// Criterion 4: a wrong auth_key changes nothing and counts against the
// same limit as UnlockUserKey.
func TestChangePassphraseWithAWrongAuthKeyCountsAgainstTheLimitAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")
	material := newUserKeyMaterial(t)
	require.NoError(t, fixture.createUserKey(t, token, material))

	next := material.rewrapped(t)
	requireWrongPassphrase(t, fixture.changePassphrase(t, 0, token, randomBytes(t, 32), material.publicKey, next))

	fixture.requireUnlocksTo(t, token, material.authKey, material)

	for attempt := range unlockAttempts - 2 {
		requireWrongPassphrase(t, fixture.unlockUserKeyErr(t, attempt, token, randomBytes(t, 32)))
	}

	// The change's failure was attempt 1: this is attempt N.
	requireWrongPassphrase(t, fixture.changePassphrase(t, 1, token, randomBytes(t, 32), material.publicKey, next))
	requireExhausted(t, fixture.unlockUserKeyErr(t, 0, token, material.authKey))
}

// Criterion 5: the database holds no key material unwrapped. The test
// wraps a real private key as a device would (internal/e2ee: Argon2id, then
// wrap_key and auth_key by HKDF, docs/design/crypto.md) and searches every
// row of every table for the secrets.
func TestDatabaseHoldsNoUnwrappedKeyMaterialAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")

	privateKey, publicKey, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	const passphrase = "correct horse battery staple"

	params := e2ee.Argon2Params{Memory: e2ee.MinArgon2Memory, Iterations: e2ee.MinArgon2Iterations, Parallelism: 1}
	wrapped, authKey, err := e2ee.WrapWithPassphraseParams(passphrase, params, privateKey, nil)
	require.NoError(t, err)

	headerParams, salt, err := e2ee.ParsePassphraseHeader(wrapped)
	require.NoError(t, err)
	require.Equal(t, params, headerParams)

	keys, err := e2ee.DerivePassphraseKeys(passphrase, params, salt)
	require.NoError(t, err)
	require.Equal(t, authKey, keys.AuthKey)

	// The Argon2id output both keys are derived from (the passphrase is
	// ASCII, so NFC leaves it unchanged).
	derived := argon2.IDKey([]byte(passphrase), salt, params.Iterations, params.Memory, params.Parallelism, e2ee.KeySize)

	material := userKeyMaterial{
		publicKey: publicKey,
		wrapped:   wrapped,
		params: &vaultsyncv1.PassphraseParams{
			Suite: 2, MemoryKib: params.Memory, Iterations: params.Iterations, Parallelism: uint32(params.Parallelism), Salt: salt,
		},
		authKey: authKey,
	}
	require.NoError(t, fixture.createUserKey(t, token, material))

	_, err = fixture.unlockUserKey(t, 0, token, authKey)
	require.NoError(t, err)

	// A wrong attempt and a passphrase change leave nothing behind either.
	requireWrongPassphrase(t, fixture.unlockUserKeyErr(t, 1, token, randomBytes(t, 32)))

	next := material.rewrapped(t)
	require.NoError(t, fixture.changePassphrase(t, 0, token, authKey, publicKey, next))

	secrets := map[string][]byte{
		"private key":     privateKey,
		"passphrase":      []byte(passphrase),
		"Argon2id output": derived,
		"wrap_key":        keys.WrapKey,
		"auth_key":        authKey,
		"new auth_key":    next.authKey,
	}

	rows, err := fixture.pool.Query(t.Context(), `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)
	require.NoError(t, err)
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)
	require.Contains(t, tables, "user_keys")

	var stored bytes.Buffer

	for _, table := range tables {
		rows, err := fixture.pool.Query(t.Context(), `SELECT row_to_json(t)::text FROM `+pgx.Identifier{table}.Sanitize()+` t`)
		require.NoError(t, err)
		values, err := pgx.CollectRows(rows, pgx.RowTo[string])
		require.NoError(t, err)

		for _, value := range values {
			stored.WriteString(value)
			stored.WriteByte('\n')
		}
	}

	// bytea columns render as \x-prefixed hex in JSON.
	require.Contains(t, stored.String(), hex.EncodeToString(next.wrapped), "the search sees the user_keys row")

	for name, secret := range secrets {
		assert.NotContains(t, stored.String(), hex.EncodeToString(secret), "%s is stored", name)
		assert.NotContains(t, stored.String(), string(secret), "%s is stored", name)
	}
}

// Criterion 6: another user can neither read, unlock nor replace a user's
// key, and an unauthenticated caller is rejected.
func TestUserKeysAreOnlyTheirOwnersAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.token(t, "alice")
	bob := fixture.token(t, "bob")

	material := newUserKeyMaterial(t)
	require.NoError(t, fixture.createUserKey(t, alice, material))

	// Bob has no key, whatever he presents.
	_, err := fixture.userKeys(0).GetUserKeyParams(t.Context(), authorized(&vaultsyncv1.GetUserKeyParamsRequest{}, bob))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), err)

	for range unlockAttempts + 1 {
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(fixture.unlockUserKeyErr(t, 0, bob, material.authKey)))
	}

	err = fixture.changePassphrase(t, 0, bob, material.authKey, material.publicKey, newUserKeyMaterial(t))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), err)

	// Bob's own key does not open with Alice's auth_key, and his failures
	// count only against him.
	bobs := newUserKeyMaterial(t)
	require.NoError(t, fixture.createUserKey(t, bob, bobs))

	for attempt := range unlockAttempts {
		requireWrongPassphrase(t, fixture.changePassphrase(t, attempt, bob, material.authKey, material.publicKey, material.rewrapped(t)))
	}

	requireExhausted(t, fixture.unlockUserKeyErr(t, 0, bob, bobs.authKey))
	fixture.requireUnlocksTo(t, alice, material.authKey, material)
}

// Criterion 6: without a token, every procedure is UNAUTHENTICATED.
func TestUserKeyProceduresRequireAuthenticationAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	client := fixture.userKeys(0)

	calls := map[string]func() error{
		"GetUserKeyParams": func() error {
			_, err := client.GetUserKeyParams(t.Context(), connect.NewRequest(&vaultsyncv1.GetUserKeyParamsRequest{}))
			return err
		},
		"CreateUserKey": func() error {
			_, err := client.CreateUserKey(t.Context(), connect.NewRequest(&vaultsyncv1.CreateUserKeyRequest{}))
			return err
		},
		"UnlockUserKey": func() error {
			_, err := client.UnlockUserKey(t.Context(), connect.NewRequest(&vaultsyncv1.UnlockUserKeyRequest{}))
			return err
		},
		"ChangePassphrase": func() error {
			_, err := client.ChangePassphrase(t.Context(), connect.NewRequest(&vaultsyncv1.ChangePassphraseRequest{}))
			return err
		},
	}

	for name, call := range calls {
		err := call()
		assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), "%s: %v", name, errors.Unwrap(err))
	}
}
