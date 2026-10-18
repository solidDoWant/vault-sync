package auth_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
)

const minRefreshInterval = 30 * time.Second

// clock is a manually advanced clock.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *clock { return &clock{now: time.Now().Truncate(time.Second)} }

func (clock *clock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()

	return clock.now
}

func (clock *clock) Advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()

	clock.now = clock.now.Add(duration)
}

func newVerifier(issuer *authtest.Issuer, clock *clock) *auth.Verifier {
	return auth.NewVerifier(auth.VerifierOptions{
		IssuerURL:          issuer.URL,
		Audience:           authtest.DefaultAudience,
		Now:                clock.Now,
		MinRefreshInterval: minRefreshInterval,
		MaxKeyAge:          time.Hour,
	})
}

func randomSubject() string {
	subject := make([]byte, 8)
	_, _ = rand.Read(subject)

	return "user-" + hex.EncodeToString(subject)
}

func TestVerifierAcceptsEachAllowedAlgorithm(t *testing.T) {
	for _, algorithm := range []jose.SignatureAlgorithm{jose.RS256, jose.ES256, jose.EdDSA} {
		t.Run(string(algorithm), func(t *testing.T) {
			issuer := authtest.NewIssuer(t)
			key := issuer.AddKey(t, algorithm)
			clock := newClock()

			identity, err := newVerifier(issuer, clock).Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
			require.NoError(t, err)

			assert.Equal(t, auth.Identity{Issuer: issuer.URL, Subject: "alice"}, identity)
		})
	}
}

func TestVerifierRejectsTokensNotYetValidBeyondTheLeeway(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)
	clock := newClock()
	verifier := newVerifier(issuer, clock)

	// The offsets are literal, not derived from auth.NotBeforeLeeway, so that
	// widening the leeway (go-oidc alone tolerates five minutes) fails here.
	tests := []struct {
		name        string
		notBefore   time.Duration
		assertError require.ErrorAssertionFunc
	}{
		{name: "now", notBefore: 0},
		{name: "59 seconds ahead", notBefore: 59 * time.Second},
		{name: "60 seconds ahead", notBefore: 60 * time.Second},
		{name: "61 seconds ahead", notBefore: 61 * time.Second, assertError: requireUnauthenticated},
		{name: "2 minutes ahead", notBefore: 2 * time.Minute, assertError: requireUnauthenticated},
		{name: "4 minutes ahead", notBefore: 4 * time.Minute, assertError: requireUnauthenticated},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.assertError == nil {
				test.assertError = require.NoError
			}

			claims := issuer.Claims("alice", clock.Now())
			claims["nbf"] = clock.Now().Add(test.notBefore).Unix()

			_, err := verifier.Verify(t.Context(), authtest.Sign(t, key, claims))
			test.assertError(t, err)
		})
	}
}

func requireUnauthenticated(t require.TestingT, err error, args ...any) {
	require.ErrorIs(t, err, auth.ErrUnauthenticated, args...)
}

func TestAuthenticatorBoundsTheSubjectLength(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)
	clock := newClock()

	tests := []struct {
		name        string
		subject     string
		assertError require.ErrorAssertionFunc
	}{
		{name: "255 bytes", subject: strings.Repeat("s", 255)},
		{name: "255 bytes of multi-byte characters", subject: strings.Repeat("é", 127) + "s"},
		{name: "256 bytes", subject: strings.Repeat("s", 256), assertError: requireUnauthenticated},
		{name: "256 bytes of multi-byte characters", subject: strings.Repeat("é", 128), assertError: requireUnauthenticated},
		{name: "1 KiB", subject: strings.Repeat("s", 1024), assertError: requireUnauthenticated},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.assertError == nil {
				test.assertError = require.NoError
			}

			users := &memoryUsers{users: map[auth.Identity]uuid.UUID{}}
			authenticator := auth.NewAuthenticator(newVerifier(issuer, clock), users)

			user, err := authenticator.AuthenticateToken(t.Context(), authtest.Sign(t, key, issuer.Claims(test.subject, clock.Now())))
			test.assertError(t, err)

			if err != nil {
				assert.Empty(t, users.users, "no user is created for a rejected token")

				return
			}

			assert.Equal(t, test.subject, user.Identity.Subject)
			assert.Len(t, users.users, 1)
		})
	}
}

func TestVerifierRefreshesKeysAfterRotation(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	oldKey := issuer.AddKey(t, jose.RS256)
	clock := newClock()
	verifier := newVerifier(issuer, clock)

	_, err := verifier.Verify(t.Context(), authtest.Sign(t, oldKey, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err)
	require.Equal(t, 1, issuer.JWKSRequests())

	// The issuer rotates to a new key some time later.
	clock.Advance(10 * time.Minute)

	newKey := issuer.AddKey(t, jose.ES256)
	issuer.Withdraw(oldKey)

	identity, err := verifier.Verify(t.Context(), authtest.Sign(t, newKey, issuer.Claims("bob", clock.Now())))
	require.NoError(t, err)
	assert.Equal(t, "bob", identity.Subject)
	assert.Equal(t, 2, issuer.JWKSRequests(), "the unknown kid triggers exactly one refresh")

	// Known keys need no further refresh.
	_, err = verifier.Verify(t.Context(), authtest.Sign(t, newKey, issuer.Claims("carol", clock.Now())))
	require.NoError(t, err)
	assert.Equal(t, 2, issuer.JWKSRequests())
}

func TestVerifierRateLimitsRefreshesForUnknownKeyIDs(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.RS256)
	clock := newClock()
	verifier := newVerifier(issuer, clock)

	_, err := verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err)
	require.Equal(t, 1, issuer.JWKSRequests())

	flood := func() {
		var group sync.WaitGroup

		for range 50 {
			group.Go(func() {
				// A key the issuer never published, with a fresh kid.
				token := authtest.Sign(t, authtest.NewKey(t, jose.EdDSA), issuer.Claims("mallory", clock.Now()))

				_, err := verifier.Verify(t.Context(), token)
				assert.ErrorIs(t, err, auth.ErrUnauthenticated)
			})
		}

		group.Wait()
	}

	clock.Advance(minRefreshInterval)
	flood()
	assert.Equal(t, 2, issuer.JWKSRequests(), "50 unknown kids within one interval cause one refresh")

	clock.Advance(minRefreshInterval / 2)
	flood()
	assert.Equal(t, 2, issuer.JWKSRequests(), "no refresh before the interval has passed")

	clock.Advance(minRefreshInterval / 2)
	flood()
	assert.Equal(t, 3, issuer.JWKSRequests(), "one refresh per interval")

	// Legitimate tokens keep working throughout.
	_, err = verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err)
}

func TestVerifierStopsTrustingWithdrawnKeysAfterMaxKeyAge(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.RS256)
	clock := newClock()
	verifier := newVerifier(issuer, clock)

	_, err := verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err)

	issuer.AddKey(t, jose.RS256)
	issuer.Withdraw(key)
	clock.Advance(time.Hour)

	_, err = verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.ErrorIs(t, err, auth.ErrUnauthenticated)
}

func TestVerifierRejectsTokensWhenTheIssuerIsUnusable(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{
			name: "unreachable",
			handler: func(writer http.ResponseWriter, _ *http.Request) {
				http.Error(writer, "down", http.StatusServiceUnavailable)
			},
		},
		{
			name: "discovery names another issuer",
			handler: func(writer http.ResponseWriter, request *http.Request) {
				_ = json.NewEncoder(writer).Encode(map[string]string{
					"issuer":   "https://evil.example",
					"jwks_uri": "http://" + request.Host + "/jwks",
				})
			},
		},
		{
			name: "oversized discovery document",
			handler: func(writer http.ResponseWriter, _ *http.Request) {
				_, _ = writer.Write(make([]byte, 2<<20))
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(test.handler)
			t.Cleanup(server.Close)

			key := authtest.NewKey(t, jose.RS256)
			now := time.Now()
			verifier := auth.NewVerifier(auth.VerifierOptions{IssuerURL: server.URL, Audience: authtest.DefaultAudience})

			_, err := verifier.Verify(t.Context(), authtest.Sign(t, key, map[string]any{
				"iss": server.URL, "sub": "alice", "aud": authtest.DefaultAudience, "exp": now.Add(time.Hour).Unix(),
			}))
			require.ErrorIs(t, err, auth.ErrUnauthenticated)
		})
	}
}

// memoryUsers is an in-memory auth.UserStore.
type memoryUsers struct {
	mu    sync.Mutex
	users map[auth.Identity]uuid.UUID
}

func (users *memoryUsers) UpsertUser(_ context.Context, issuer, subject string) (uuid.UUID, error) {
	users.mu.Lock()
	defer users.mu.Unlock()

	identity := auth.Identity{Issuer: issuer, Subject: subject}
	if id, ok := users.users[identity]; ok {
		return id, nil
	}

	id := uuid.New()
	users.users[identity] = id

	return id, nil
}

func TestAuthenticatorProvisionsUsersByIssuerAndSubject(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.RS256)
	clock := newClock()
	users := &memoryUsers{users: map[auth.Identity]uuid.UUID{}}
	authenticator := auth.NewAuthenticator(newVerifier(issuer, clock), users)

	alice := randomSubject()

	first, err := authenticator.AuthenticateHeader(t.Context(), "Bearer "+authtest.Sign(t, key, issuer.Claims(alice, clock.Now())))
	require.NoError(t, err)

	again, err := authenticator.AuthenticateToken(t.Context(), authtest.Sign(t, key, issuer.Claims(alice, clock.Now())))
	require.NoError(t, err)

	other, err := authenticator.AuthenticateToken(t.Context(), authtest.Sign(t, key, issuer.Claims(randomSubject(), clock.Now())))
	require.NoError(t, err)

	assert.Equal(t, first.ID, again.ID)
	assert.NotEqual(t, first.ID, other.ID)
	assert.Equal(t, auth.Identity{Issuer: issuer.URL, Subject: alice}, first.Identity)
	assert.Equal(t, users.users[first.Identity], first.ID)
}

func TestAuthenticateHeaderRequiresBearerScheme(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.RS256)
	clock := newClock()
	authenticator := auth.NewAuthenticator(newVerifier(issuer, clock), &memoryUsers{users: map[auth.Identity]uuid.UUID{}})
	token := authtest.Sign(t, key, issuer.Claims("alice", clock.Now()))

	for _, header := range []string{"", token, "Basic " + token, "Bearer", "Bearer "} {
		_, err := authenticator.AuthenticateHeader(t.Context(), header)
		require.ErrorIs(t, err, auth.ErrUnauthenticated, "header %.20q", header)
	}

	_, err := authenticator.AuthenticateHeader(t.Context(), "bearer "+token)
	require.NoError(t, err, "the scheme is case-insensitive")
}
