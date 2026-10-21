package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// memoryStore is an in-memory user and device store for tests that are not
// about persistence.
type memoryStore struct {
	mu      sync.Mutex
	users   map[auth.Identity]uuid.UUID
	devices []store.Device
}

func newMemoryStore() *memoryStore {
	return &memoryStore{users: map[auth.Identity]uuid.UUID{}}
}

func (memory *memoryStore) UpsertUser(_ context.Context, issuer, subject string) (uuid.UUID, error) {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	identity := auth.Identity{Issuer: issuer, Subject: subject}
	if id, ok := memory.users[identity]; ok {
		return id, nil
	}

	id := uuid.New()
	memory.users[identity] = id

	return id, nil
}

func (memory *memoryStore) RegisterDevice(_ context.Context, userID uuid.UUID, name string, publicKey []byte, _ int) (store.Device, error) {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	device := store.Device{ID: uuid.New(), UserID: userID, Name: name, PublicKey: publicKey, CreatedAt: time.Now()}
	memory.devices = append(memory.devices, device)

	return device, nil
}

func (memory *memoryStore) ListDevices(_ context.Context, userID uuid.UUID) ([]store.Device, error) {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	var devices []store.Device

	for _, device := range memory.devices {
		if device.UserID == userID {
			devices = append(devices, device)
		}
	}

	return devices, nil
}

func (memory *memoryStore) RemoveDevice(_ context.Context, userID, deviceID uuid.UUID) error {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	for index, device := range memory.devices {
		if device.ID == deviceID && device.UserID == userID {
			memory.devices = append(memory.devices[:index], memory.devices[index+1:]...)

			return nil
		}
	}

	return store.ErrDeviceNotFound
}

func (memory *memoryStore) userCount() int {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	return len(memory.users)
}

// authFixture is a server whose tokens come from a local fake issuer.
type authFixture struct {
	issuer  *authtest.Issuer
	key     authtest.Key
	running *runningServer
	logs    *syncBuffer
}

type syncBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *syncBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()

	return buffer.buffer.Write(data)
}

func (buffer *syncBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()

	return buffer.buffer.String()
}

type authStore interface {
	auth.UserStore
	api.DeviceStore
}

func newAuthFixture(t *testing.T, users authStore, database server.Pinger) *authFixture {
	t.Helper()

	issuer := authtest.NewIssuer(t)
	fixture := &authFixture{issuer: issuer, key: issuer.AddKey(t, jose.RS256), logs: &syncBuffer{}}
	logger := slog.New(slog.NewJSONHandler(fixture.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))

	verifier := auth.NewVerifier(auth.VerifierOptions{
		IssuerURL: issuer.URL,
		Audience:  authtest.DefaultAudience,
		Logger:    logger,
	})

	fixture.running = startServer(t, server.Options{
		Database:      database,
		Authenticator: auth.NewAuthenticator(verifier, users),
		Devices:       users,
		Logger:        logger,
	})

	return fixture
}

func (fixture *authFixture) token(t *testing.T, subject string) string {
	t.Helper()

	return authtest.Sign(t, fixture.key, fixture.issuer.Claims(subject, time.Now()))
}

func (fixture *authFixture) registerDevice(t *testing.T, token string, request *vaultsyncv1.RegisterDeviceRequest) (*vaultsyncv1.Device, error) {
	t.Helper()

	client := vaultsyncv1connect.NewDeviceServiceClient(http.DefaultClient, fixture.running.apiURL())
	connectRequest := connect.NewRequest(request)
	connectRequest.Header().Set("Authorization", "Bearer "+token)

	response, err := client.RegisterDevice(t.Context(), connectRequest)
	if err != nil {
		return nil, err
	}

	return response.Msg.GetDevice(), nil
}

// procedures lists every RPC defined in the vaultsync.v1 protobuf package.
func procedures(t *testing.T) []string {
	t.Helper()

	var all []string

	protoregistry.GlobalFiles.RangeFilesByPackage("vaultsync.v1", func(file protoreflect.FileDescriptor) bool {
		for serviceIndex := range file.Services().Len() {
			service := file.Services().Get(serviceIndex)
			for methodIndex := range service.Methods().Len() {
				all = append(all, "/"+string(service.FullName())+"/"+string(service.Methods().Get(methodIndex).Name()))
			}
		}

		return true
	})

	require.NotEmpty(t, all)

	return all
}

func TestPublicProceduresAllowList(t *testing.T) {
	assert.Equal(t, []string{"/vaultsync.v1.ServerInfoService/GetServerInfo"}, server.PublicProcedures)

	for _, procedure := range server.PublicProcedures {
		assert.Contains(t, procedures(t), procedure, "allow-listed procedure must exist")
	}
}

// TestEveryProcedureRequiresAuthenticationUnlessPublic calls every RPC in the
// protocol without credentials: each must be served (not 404) and must be
// rejected as unauthenticated unless it is on the public allow-list.
func TestEveryProcedureRequiresAuthenticationUnlessPublic(t *testing.T) {
	servers := map[string]*runningServer{
		// Fail closed even when no authenticator is configured.
		"without authenticator": startServer(t, server.Options{}),
		"with authenticator":    newAuthFixture(t, newMemoryStore(), nil).running,
	}

	for name, running := range servers {
		t.Run(name, func(t *testing.T) {
			for _, procedure := range procedures(t) {
				for _, authorization := range []string{"", "Bearer not-a-jwt"} {
					request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, running.apiURL()+procedure, strings.NewReader("{}"))
					require.NoError(t, err)
					request.Header.Set("Content-Type", "application/json")

					if authorization != "" {
						request.Header.Set("Authorization", authorization)
					}

					response, err := http.DefaultClient.Do(request)
					require.NoError(t, err)

					body, err := io.ReadAll(response.Body)
					require.NoError(t, err)
					require.NoError(t, response.Body.Close())

					if contains(server.PublicProcedures, procedure) {
						assert.Equal(t, http.StatusOK, response.StatusCode, "%s is public", procedure)

						continue
					}

					var connectError struct {
						Code string `json:"code"`
					}

					require.NoError(t, json.Unmarshal(body, &connectError), "%s: %s", procedure, body)
					assert.Equal(t, http.StatusUnauthorized, response.StatusCode, "%s must require authentication", procedure)
					assert.Equal(t, "unauthenticated", connectError.Code, procedure)
					assert.Equal(t, "Bearer", response.Header.Get("WWW-Authenticate"), procedure)
				}
			}
		})
	}
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}

	return false
}

func TestInvalidTokensAreRejectedAsUnauthenticated(t *testing.T) {
	users := newMemoryStore()
	fixture := newAuthFixture(t, users, nil)
	issuer := fixture.issuer
	now := time.Now()

	claims := func(modify func(map[string]any)) map[string]any {
		values := issuer.Claims("mallory", now)
		modify(values)

		return values
	}

	publicJWK, err := fixture.key.PublicJWK().MarshalJSON()
	require.NoError(t, err)

	tests := []struct {
		name  string
		token string
	}{
		{name: "expired", token: authtest.Sign(t, fixture.key, claims(func(values map[string]any) {
			values["exp"] = now.Add(-time.Minute).Unix()
		}))},
		{name: "no exp", token: authtest.Sign(t, fixture.key, claims(func(values map[string]any) { delete(values, "exp") }))},
		{name: "not yet valid", token: authtest.Sign(t, fixture.key, claims(func(values map[string]any) {
			values["nbf"] = now.Add(10 * time.Minute).Unix()
		}))},
		{name: "wrong iss", token: authtest.Sign(t, fixture.key, claims(func(values map[string]any) {
			values["iss"] = "https://other-issuer.example"
		}))},
		{name: "wrong aud", token: authtest.Sign(t, fixture.key, claims(func(values map[string]any) {
			values["aud"] = "some-other-client"
		}))},
		{name: "no sub", token: authtest.Sign(t, fixture.key, claims(func(values map[string]any) { delete(values, "sub") }))},
		{name: "unknown kid", token: authtest.Sign(t, authtest.NewKey(t, jose.RS256), claims(func(map[string]any) {}))},
		{name: "known kid, wrong key", token: authtest.Sign(t, authtest.Key{
			ID: fixture.key.ID, Algorithm: jose.RS256, Private: authtest.NewKey(t, jose.RS256).Private,
		}, claims(func(map[string]any) {}))},
		{name: "alg none", token: authtest.Unsigned(t, fixture.key.ID, claims(func(map[string]any) {}))},
		{name: "HS256 keyed with the public key", token: authtest.SignHMAC(t, fixture.key.ID, publicJWK, claims(func(map[string]any) {}))},
		{name: "HS256 without kid", token: authtest.SignHMAC(t, "", []byte("0123456789abcdef0123456789abcdef"), claims(func(map[string]any) {}))},
		{name: "algorithm not on the allow-list", token: func() string {
			key := authtest.NewKey(t, jose.RS384)
			issuer.Publish(key)

			return authtest.Sign(t, key, claims(func(map[string]any) {}))
		}()},
		{name: "oversized", token: authtest.Sign(t, fixture.key, claims(func(values map[string]any) {
			values["padding"] = strings.Repeat("a", auth.MaxTokenBytes)
		}))},
		{name: "malformed", token: "not.a.jwt"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := fixture.registerDevice(t, test.token, &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop"})
			require.Error(t, err)
			assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
		})
	}

	assert.Zero(t, users.userCount(), "no user is created for a rejected token")

	logs := fixture.logs.String()
	assert.Contains(t, logs, "rejected unauthenticated request")

	for _, test := range tests {
		for _, part := range strings.Split(test.token, ".") {
			if len(part) > 8 {
				assert.NotContains(t, logs, part, "%s: token must not be logged", test.name)
			}
		}
	}

	assert.NotContains(t, logs, "mallory", "claims must not be logged")
}

func TestValidTokenAuthenticatesTheCaller(t *testing.T) {
	users := newMemoryStore()
	fixture := newAuthFixture(t, users, nil)
	token := fixture.token(t, "alice")

	device, err := fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop"})
	require.NoError(t, err)

	assert.Equal(t, "Laptop", device.GetName())
	require.Len(t, users.devices, 1)
	assert.Equal(t, users.users[auth.Identity{Issuer: fixture.issuer.URL, Subject: "alice"}], users.devices[0].UserID)
	assert.NotContains(t, fixture.logs.String(), token)
}

func TestRegisterDeviceValidatesInput(t *testing.T) {
	fixture := newAuthFixture(t, newMemoryStore(), nil)
	token := fixture.token(t, "alice")

	tests := []struct {
		name     string
		request  *vaultsyncv1.RegisterDeviceRequest
		wantCode connect.Code
	}{
		{name: "name and key", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", PublicKey: make([]byte, 32)}},
		{name: "no key", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Phone"}},
		{name: "longest name", request: &vaultsyncv1.RegisterDeviceRequest{Name: strings.Repeat("n", api.MaxDeviceNameBytes)}},
		{name: "empty name", request: &vaultsyncv1.RegisterDeviceRequest{}, wantCode: connect.CodeInvalidArgument},
		{name: "blank name", request: &vaultsyncv1.RegisterDeviceRequest{Name: " \t"}, wantCode: connect.CodeInvalidArgument},
		{name: "over-long name", request: &vaultsyncv1.RegisterDeviceRequest{Name: strings.Repeat("n", api.MaxDeviceNameBytes+1)}, wantCode: connect.CodeInvalidArgument},
		{name: "non-ASCII name", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Jürgen’s Pixel 📱"}},
		{name: "NUL in name", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Lap\x00top"}, wantCode: connect.CodeInvalidArgument},
		{name: "newline in name", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Lap\ntop"}, wantCode: connect.CodeInvalidArgument},
		{name: "escape sequence in name", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop\x1b[2J"}, wantCode: connect.CodeInvalidArgument},
		{name: "DEL in name", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop\x7f"}, wantCode: connect.CodeInvalidArgument},
		{name: "C1 control in name", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop\u0085"}, wantCode: connect.CodeInvalidArgument},
		{name: "short key", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", PublicKey: make([]byte, 31)}, wantCode: connect.CodeInvalidArgument},
		{name: "long key", request: &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", PublicKey: make([]byte, 33)}, wantCode: connect.CodeInvalidArgument},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			device, err := fixture.registerDevice(t, token, test.request)
			if test.wantCode == 0 {
				require.NoError(t, err)
				assert.Equal(t, test.request.GetName(), device.GetName())
				assert.NotEmpty(t, device.GetId())

				return
			}

			require.Error(t, err)
			assert.Equal(t, test.wantCode, connect.CodeOf(err))
		})
	}
}
