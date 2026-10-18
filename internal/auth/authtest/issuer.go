// Package authtest provides a local fake OIDC issuer for tests: an httptest
// server publishing an OpenID configuration and a JSON Web Key Set, plus
// helpers to mint valid and deliberately invalid access tokens. It never
// touches the network beyond loopback.
package authtest

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/stretchr/testify/require"
)

// DefaultAudience is the audience Claims puts in tokens.
const DefaultAudience = "vault-sync"

// Key is a signing key of the fake issuer.
type Key struct {
	ID        string
	Algorithm jose.SignatureAlgorithm
	Private   crypto.Signer
}

// PublicJWK returns the key's public JSON Web Key.
func (key Key) PublicJWK() jose.JSONWebKey {
	return jose.JSONWebKey{Key: key.Private.Public(), KeyID: key.ID, Algorithm: string(key.Algorithm), Use: "sig"}
}

// Issuer is a fake OIDC issuer.
type Issuer struct {
	// URL is the issuer identifier (and base URL).
	URL string

	server       *httptest.Server
	jwksRequests atomic.Int64

	mu        sync.Mutex
	published []Key
}

// NewIssuer starts a fake issuer that is stopped when the test ends.
func NewIssuer(t testing.TB) *Issuer {
	t.Helper()

	issuer := &Issuer{}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, map[string]any{
			"issuer":                                issuer.URL,
			"jwks_uri":                              issuer.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256", "ES256", "EdDSA"},
		})
	})
	mux.HandleFunc("GET /jwks", func(writer http.ResponseWriter, _ *http.Request) {
		issuer.jwksRequests.Add(1)

		issuer.mu.Lock()
		set := jose.JSONWebKeySet{}

		for _, key := range issuer.published {
			set.Keys = append(set.Keys, key.PublicJWK())
		}
		issuer.mu.Unlock()

		writeJSON(writer, set)
	})

	issuer.server = httptest.NewServer(mux)
	issuer.URL = issuer.server.URL
	t.Cleanup(issuer.server.Close)

	return issuer
}

func writeJSON(writer http.ResponseWriter, value any) {
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(value)
}

// JWKSRequests is the number of key set requests served so far.
func (issuer *Issuer) JWKSRequests() int {
	return int(issuer.jwksRequests.Load())
}

// NewKey generates a key for algorithm (RS256, RS384, ES256 or EdDSA)
// without publishing it.
func NewKey(t testing.TB, algorithm jose.SignatureAlgorithm) Key {
	t.Helper()

	var (
		private crypto.Signer
		err     error
	)

	switch algorithm {
	case jose.RS256, jose.RS384:
		private, err = rsa.GenerateKey(rand.Reader, 2048)
	case jose.ES256:
		private, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	case jose.EdDSA:
		_, private, err = ed25519.GenerateKey(rand.Reader)
	default:
		t.Fatalf("authtest: unsupported algorithm %s", algorithm)
	}

	require.NoError(t, err)

	id := make([]byte, 8)
	_, _ = rand.Read(id)

	return Key{ID: hex.EncodeToString(id), Algorithm: algorithm, Private: private}
}

// AddKey generates and publishes a key.
func (issuer *Issuer) AddKey(t testing.TB, algorithm jose.SignatureAlgorithm) Key {
	t.Helper()

	key := NewKey(t, algorithm)
	issuer.Publish(key)

	return key
}

// Publish adds key to the key set.
func (issuer *Issuer) Publish(key Key) {
	issuer.mu.Lock()
	defer issuer.mu.Unlock()

	issuer.published = append(issuer.published, key)
}

// Withdraw removes key from the key set.
func (issuer *Issuer) Withdraw(key Key) {
	issuer.mu.Lock()
	defer issuer.mu.Unlock()

	kept := issuer.published[:0]

	for _, published := range issuer.published {
		if published.ID != key.ID {
			kept = append(kept, published)
		}
	}

	issuer.published = kept
}

// Claims returns valid access-token claims for subject, issued now and
// expiring in an hour.
func (issuer *Issuer) Claims(subject string, now time.Time) map[string]any {
	return map[string]any{
		"iss": issuer.URL,
		"sub": subject,
		"aud": DefaultAudience,
		"iat": now.Unix(),
		"nbf": now.Unix(),
		"exp": now.Add(time.Hour).Unix(),
	}
}

// Sign returns a JWT with claims, signed by key and naming its key id.
func Sign(t testing.TB, key Key, claims map[string]any) string {
	t.Helper()

	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: key.Algorithm, Key: jose.JSONWebKey{Key: key.Private, KeyID: key.ID}},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	require.NoError(t, err)

	return sign(t, signer, claims)
}

// SignHMAC returns a JWT with claims signed with HS256 under secret, naming
// keyID (for example a published asymmetric key's id, as in an algorithm
// confusion attack).
func SignHMAC(t testing.TB, keyID string, secret []byte, claims map[string]any) string {
	t.Helper()

	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.HS256, Key: jose.JSONWebKey{Key: secret, KeyID: keyID}},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	require.NoError(t, err)

	return sign(t, signer, claims)
}

// Unsigned returns a JWT with "alg": "none" and an empty signature.
func Unsigned(t testing.TB, keyID string, claims map[string]any) string {
	t.Helper()

	header, err := json.Marshal(map[string]string{"alg": "none", "typ": "JWT", "kid": keyID})
	require.NoError(t, err)

	payload, err := json.Marshal(claims)
	require.NoError(t, err)

	return base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload) + "."
}

func sign(t testing.TB, signer jose.Signer, claims map[string]any) string {
	t.Helper()

	payload, err := json.Marshal(claims)
	require.NoError(t, err)

	signed, err := signer.Sign(payload)
	require.NoError(t, err)

	token, err := signed.CompactSerialize()
	require.NoError(t, err)

	return token
}
