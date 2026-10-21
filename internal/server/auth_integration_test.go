//go:build integration

package server_test

import (
	"log/slog"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

func migratedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	pool, err := store.Open(t.Context(), testinfra.PostgresConfig(t))
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	return pool
}

func userID(t *testing.T, pool *pgxpool.Pool, issuer, subject string) uuid.UUID {
	t.Helper()

	var id uuid.UUID

	require.NoError(t, pool.QueryRow(t.Context(),
		`SELECT id FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2`, issuer, subject).Scan(&id))

	return id
}

func TestAuthenticatedCallerIsProvisionedAndSeesOnlyTheirDevices(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)
	fixture := newAuthFixture(t, queries, pool)

	publicKey := make([]byte, api.PublicKeyBytes)
	publicKey[0] = 9

	laptop, err := fixture.registerDevice(t, fixture.token(t, "alice"), &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", PublicKey: publicKey})
	require.NoError(t, err)

	phone, err := fixture.registerDevice(t, fixture.token(t, "alice"), &vaultsyncv1.RegisterDeviceRequest{Name: "Phone"})
	require.NoError(t, err)

	desktop, err := fixture.registerDevice(t, fixture.token(t, "bob"), &vaultsyncv1.RegisterDeviceRequest{Name: "Desktop"})
	require.NoError(t, err)

	// Each caller exists exactly once, keyed by (issuer, subject).
	var users int

	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM users`).Scan(&users))
	assert.Equal(t, 2, users)

	alice := userID(t, pool, fixture.issuer.URL, "alice")
	bob := userID(t, pool, fixture.issuer.URL, "bob")

	aliceDevices, err := queries.ListDevices(t.Context(), alice)
	require.NoError(t, err)

	bobDevices, err := queries.ListDevices(t.Context(), bob)
	require.NoError(t, err)

	assert.Equal(t, []string{laptop.GetId(), phone.GetId()}, deviceIDStrings(aliceDevices))
	assert.Equal(t, []string{desktop.GetId()}, deviceIDStrings(bobDevices))
	assert.Equal(t, publicKey, aliceDevices[0].PublicKey)
}

func deviceIDStrings(devices []store.Device) []string {
	ids := make([]string, 0, len(devices))
	for _, device := range devices {
		ids = append(ids, device.ID.String())
	}

	return ids
}

func TestRegisterDeviceRejectsControlCharactersBeforeTheDatabase(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	token := fixture.token(t, "alice")

	// PostgreSQL text cannot hold U+0000; the name must be rejected as the
	// caller's mistake, not surface as an internal error.
	for _, name := range []string{"Lap\x00top", "\x00", "Laptop\x1b[2J"} {
		_, err := fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: name})
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "%q", name)
	}

	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`)

	var devices int

	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM devices`).Scan(&devices))
	assert.Zero(t, devices)
}

func TestControlCharactersInTheSubjectAreRejectedBeforeTheDatabase(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)

	// PostgreSQL text cannot hold U+0000; a validly signed token carrying one
	// must be rejected as unauthenticated, not surface as an internal error.
	for _, subject := range []string{"ali\x00ce", "\x00", "alice\x1b[2J", "alice\u0085"} {
		_, err := fixture.registerDevice(t, fixture.token(t, subject), &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop"})
		require.Error(t, err)
		assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), "%q", subject)
	}

	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`)

	var users int

	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM users`).Scan(&users))
	assert.Zero(t, users)

	// A normal subject is still provisioned.
	_, err := fixture.registerDevice(t, fixture.token(t, "alice"), &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop"})
	require.NoError(t, err)
	userID(t, pool, fixture.issuer.URL, "alice")
}

func TestRegisterDeviceLimit(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	token := fixture.token(t, "alice")

	for range api.MaxDevicesPerUser {
		_, err := fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: "Device"})
		require.NoError(t, err)
	}

	_, err := fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: "One too many"})
	require.Error(t, err)
	assert.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
	// Issue #428: the refusal names its reason, so a client can tell it
	// apart from the per-user concurrency limit without reading the message.
	assert.Equal(t, vaultsyncv1.ErrorReason_ERROR_REASON_DEVICE_LIMIT, api.ErrorReasonOf(err))
}
