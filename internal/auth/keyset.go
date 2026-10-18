package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
)

// AllowedAlgorithms are the only JWS algorithms accepted on access tokens.
// "none" and every HMAC algorithm are excluded: the server holds no shared
// secret with the issuer, and an HMAC token could be forged with a public key
// as its secret.
var AllowedAlgorithms = []string{oidc.RS256, oidc.ES256, oidc.EdDSA}

// Bounds on what the server fetches from the issuer.
const (
	// maxDocumentBytes bounds the discovery document and the JWKS.
	maxDocumentBytes = 1 << 20
	// maxKeys bounds the number of keys kept from a JWKS.
	maxKeys = 64
	// fetchTimeout bounds one discovery or JWKS request.
	fetchTimeout = 10 * time.Second
)

var (
	errUnknownKey          = errors.New("no key in the issuer's key set verifies the token")
	errRefreshRateLimited  = errors.New("key set refresh rate-limited")
	errUnexpectedAlgorithm = errors.New("key algorithm does not match the token")
)

func allowedJOSEAlgorithms() []jose.SignatureAlgorithm {
	algorithms := make([]jose.SignatureAlgorithm, 0, len(AllowedAlgorithms))
	for _, algorithm := range AllowedAlgorithms {
		algorithms = append(algorithms, jose.SignatureAlgorithm(algorithm))
	}

	return algorithms
}

// remoteKeySet is the issuer's JSON Web Key Set, discovered from the issuer's
// OpenID configuration. It implements oidc.KeySet.
//
// Keys are fetched lazily. They are refetched when a token names a key id the
// cached set lacks (key rotation) or when the cached set is older than
// maxKeyAge (key revocation), but never more often than once per
// minRefreshInterval, so a flood of tokens with made-up key ids cannot turn
// the server into an amplifier against the issuer.
type remoteKeySet struct {
	issuer             string
	client             *http.Client
	now                func() time.Time
	minRefreshInterval time.Duration
	maxKeyAge          time.Duration
	logger             *slog.Logger

	// mu guards keys and fetchedAt.
	mu        sync.RWMutex
	keys      []jose.JSONWebKey
	fetchedAt time.Time

	// refreshMu serializes refreshes and guards lastAttempt and jwksURL.
	refreshMu   sync.Mutex
	lastAttempt time.Time
	jwksURL     string
}

var _ oidc.KeySet = (*remoteKeySet)(nil)

func (keySet *remoteKeySet) snapshot() ([]jose.JSONWebKey, time.Time) {
	keySet.mu.RLock()
	defer keySet.mu.RUnlock()

	return keySet.keys, keySet.fetchedAt
}

// VerifySignature verifies the token's signature against the issuer's keys
// and returns its payload.
func (keySet *remoteKeySet) VerifySignature(ctx context.Context, token string) ([]byte, error) {
	signed, err := jose.ParseSigned(token, allowedJOSEAlgorithms())
	if err != nil {
		return nil, fmt.Errorf("malformed token: %w", err)
	}

	if len(signed.Signatures) != 1 {
		return nil, errors.New("token must carry exactly one signature")
	}

	keyID := signed.Signatures[0].Header.KeyID

	keys, fetchedAt := keySet.snapshot()
	if fetchedAt.IsZero() || keySet.now().Sub(fetchedAt) >= keySet.maxKeyAge {
		// A failed or rate-limited refresh keeps the cached keys: an issuer
		// outage must not lock out holders of still-valid tokens.
		keys, fetchedAt, _ = keySet.refresh(ctx, fetchedAt)
	}

	if payload, err := verifyWithKeys(signed, keys, keyID); err == nil || !errors.Is(err, errUnknownKey) {
		return payload, err
	}

	// The key may be new (rotation). Refetch, subject to the rate limit.
	keys, _, err = keySet.refresh(ctx, fetchedAt)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errUnknownKey, err)
	}

	return verifyWithKeys(signed, keys, keyID)
}

// verifyWithKeys verifies signed with the key named keyID or, when the token
// names none, with any key. It returns errUnknownKey when no candidate key
// exists or none verifies a token without a key id.
func verifyWithKeys(signed *jose.JSONWebSignature, keys []jose.JSONWebKey, keyID string) ([]byte, error) {
	algorithm := signed.Signatures[0].Header.Algorithm

	for _, key := range keys {
		if keyID != "" && key.KeyID != keyID {
			continue
		}

		if key.Algorithm != "" && key.Algorithm != algorithm {
			if keyID != "" {
				return nil, errUnexpectedAlgorithm
			}

			continue
		}

		payload, err := signed.Verify(key)
		if err == nil {
			return payload, nil
		}

		if keyID != "" {
			return nil, fmt.Errorf("invalid signature: %w", err)
		}
	}

	return nil, errUnknownKey
}

// refresh refetches the key set unless another caller already refreshed it
// since observed, or the previous attempt was less than minRefreshInterval
// ago. It returns the current keys either way.
func (keySet *remoteKeySet) refresh(ctx context.Context, observed time.Time) ([]jose.JSONWebKey, time.Time, error) {
	keySet.refreshMu.Lock()
	defer keySet.refreshMu.Unlock()

	keys, fetchedAt := keySet.snapshot()
	if fetchedAt.After(observed) {
		return keys, fetchedAt, nil
	}

	now := keySet.now()
	if !keySet.lastAttempt.IsZero() && now.Sub(keySet.lastAttempt) < keySet.minRefreshInterval {
		return keys, fetchedAt, errRefreshRateLimited
	}

	keySet.lastAttempt = now

	// A refresh serves every waiting request, so it does not inherit the
	// cancellation of the one that triggered it.
	fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fetchTimeout)
	defer cancel()

	fetched, err := keySet.fetch(fetchCtx)
	if err != nil {
		keySet.logger.WarnContext(ctx, "cannot refresh the OIDC issuer's key set", "error", err)

		return keys, fetchedAt, err
	}

	keySet.mu.Lock()
	keySet.keys = fetched
	keySet.fetchedAt = now
	keySet.mu.Unlock()

	keySet.logger.InfoContext(ctx, "refreshed the OIDC issuer's key set", "keys", len(fetched))

	return fetched, now, nil
}

func (keySet *remoteKeySet) fetch(ctx context.Context) ([]jose.JSONWebKey, error) {
	if keySet.jwksURL == "" {
		jwksURL, err := keySet.discover(ctx)
		if err != nil {
			return nil, err
		}

		keySet.jwksURL = jwksURL
	}

	var set jose.JSONWebKeySet
	if err := keySet.getJSON(ctx, keySet.jwksURL, &set); err != nil {
		return nil, fmt.Errorf("fetch key set: %w", err)
	}

	keys := make([]jose.JSONWebKey, 0, len(set.Keys))

	for _, key := range set.Keys {
		if (key.Use != "" && key.Use != "sig") || !key.IsPublic() || !key.Valid() {
			continue
		}

		if len(keys) == maxKeys {
			break
		}

		keys = append(keys, key)
	}

	return keys, nil
}

// discover reads the issuer's OpenID configuration and returns its jwks_uri.
func (keySet *remoteKeySet) discover(ctx context.Context) (string, error) {
	var document struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}

	discoveryURL := strings.TrimSuffix(keySet.issuer, "/") + "/.well-known/openid-configuration"
	if err := keySet.getJSON(ctx, discoveryURL, &document); err != nil {
		return "", fmt.Errorf("fetch OpenID configuration: %w", err)
	}

	if document.Issuer != keySet.issuer {
		return "", fmt.Errorf("OpenID configuration names issuer %q, expected %q", document.Issuer, keySet.issuer)
	}

	jwksURL, err := url.Parse(document.JWKSURI)
	if err != nil || !jwksURL.IsAbs() || (jwksURL.Scheme != "https" && jwksURL.Scheme != "http") {
		return "", fmt.Errorf("OpenID configuration has an invalid jwks_uri %q", document.JWKSURI)
	}

	return jwksURL.String(), nil
}

func (keySet *remoteKeySet) getJSON(ctx context.Context, target string, value any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}

	request.Header.Set("Accept", "application/json")

	response, err := keySet.client.Do(request)
	if err != nil {
		return err
	}

	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: unexpected status %s", target, response.Status)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxDocumentBytes+1))
	if err != nil {
		return fmt.Errorf("GET %s: %w", target, err)
	}

	if len(body) > maxDocumentBytes {
		return fmt.Errorf("GET %s: response exceeds %d bytes", target, maxDocumentBytes)
	}

	if err := json.Unmarshal(body, value); err != nil {
		return fmt.Errorf("GET %s: invalid JSON: %w", target, err)
	}

	return nil
}
