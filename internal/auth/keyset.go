package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
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
	// maxRedirects bounds the redirects followed by one discovery or JWKS
	// request.
	maxRedirects = 5
)

var (
	errUnknownKey          = errors.New("no key in the issuer's key set verifies the token")
	errRefreshRateLimited  = errors.New("key set refresh rate-limited")
	errRefreshInFlight     = errors.New("key set refresh in flight")
	errUnexpectedAlgorithm = errors.New("key algorithm does not match the token")
)

// IsLoopbackHost reports whether host (a host name or IP address without a
// port) is "localhost" or a loopback IP address. Plain http to the OIDC
// issuer is allowed only for such hosts.
func IsLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}

	ip := net.ParseIP(host)

	return ip != nil && ip.IsLoopback()
}

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
//
// At most one fetch is in flight, and no lock is held across it, so a slow
// or hanging issuer stalls only the requests that cannot be served without
// the fetch: the one that started it, those with no cached key to use, and
// those naming an unknown key id.
//
// Every URL fetched (the discovery document, the jwks_uri and each redirect)
// must be https. Plain http is allowed only to a loopback host and only when
// the issuer itself is a loopback http URL (local development). Redirects
// must stay on the host and scheme of the URL first requested.
type remoteKeySet struct {
	issuer             string
	allowCleartext     bool
	client             *http.Client
	now                func() time.Time
	minRefreshInterval time.Duration
	maxKeyAge          time.Duration
	logger             *slog.Logger
	metrics            *Metrics

	// mu guards keys, fetchedAt, lastAttempt and inflight. It is never held
	// during a fetch.
	mu          sync.Mutex
	keys        []jose.JSONWebKey
	fetchedAt   time.Time
	lastAttempt time.Time
	inflight    *refresh

	// jwksURL is used only by the refresh in flight; refreshes are
	// serialized through inflight.
	jwksURL string
}

// refresh is one fetch of the key set. Its fields are set before done is
// closed.
type refresh struct {
	done      chan struct{}
	keys      []jose.JSONWebKey
	fetchedAt time.Time
	err       error
}

var _ oidc.KeySet = (*remoteKeySet)(nil)

func newRemoteKeySet(options VerifierOptions) *remoteKeySet {
	keySet := &remoteKeySet{
		issuer:             options.IssuerURL,
		now:                options.Now,
		minRefreshInterval: options.MinRefreshInterval,
		maxKeyAge:          options.MaxKeyAge,
		logger:             options.Logger,
		metrics:            options.Metrics,
	}

	if issuer, err := url.Parse(options.IssuerURL); err == nil {
		keySet.allowCleartext = issuer.Scheme == "http" && IsLoopbackHost(issuer.Hostname())
	}

	// The caller's client is copied so that the redirect policy applies
	// without modifying it.
	client := *options.HTTPClient
	callerCheck := client.CheckRedirect
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if err := keySet.checkRedirect(request, via); err != nil {
			return err
		}

		if callerCheck != nil {
			return callerCheck(request, via)
		}

		return nil
	}
	keySet.client = &client

	return keySet
}

// checkFetchURL returns an error unless target may be fetched.
func (keySet *remoteKeySet) checkFetchURL(target *url.URL) error {
	switch {
	case target.Host == "":
	case target.Scheme == "https":
		return nil
	case target.Scheme == "http" && keySet.allowCleartext && IsLoopbackHost(target.Hostname()):
		return nil
	}

	return fmt.Errorf("refusing to fetch %s: the issuer's documents must be fetched over https", target.Redacted())
}

// checkRedirect allows a redirect only to the host first requested, without
// a downgrade from https, and to a URL checkFetchURL allows.
func (keySet *remoteKeySet) checkRedirect(request *http.Request, via []*http.Request) error {
	// via holds the requests already made, so this is redirect len(via).
	if len(via) > maxRedirects {
		return fmt.Errorf("stopped after %d redirects", maxRedirects)
	}

	origin := via[0].URL
	if !strings.EqualFold(request.URL.Host, origin.Host) {
		return fmt.Errorf("refusing a redirect from %s to another host", origin.Redacted())
	}

	if origin.Scheme == "https" && request.URL.Scheme != "https" {
		return fmt.Errorf("refusing a redirect from %s to %s", origin.Redacted(), request.URL.Redacted())
	}

	return keySet.checkFetchURL(request.URL)
}

func (keySet *remoteKeySet) snapshot() ([]jose.JSONWebKey, time.Time) {
	keySet.mu.Lock()
	defer keySet.mu.Unlock()

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

	switch {
	case fetchedAt.IsZero():
		// Nothing is cached: wait for a fetch.
		keys, fetchedAt, _ = keySet.refresh(ctx, fetchedAt, true)
	case keySet.now().Sub(fetchedAt) >= keySet.maxKeyAge:
		// The request that starts the refresh waits for it, so that keys
		// the issuer withdrew stop being trusted. Requests arriving while
		// it is in flight use the cached keys rather than queue behind an
		// issuer that may hang. A failed or rate-limited refresh keeps the
		// cached keys too: an issuer outage must not lock out holders of
		// still-valid tokens.
		keys, fetchedAt, _ = keySet.refresh(ctx, fetchedAt, false)
	}

	if payload, err := verifyWithKeys(signed, keys, keyID); err == nil || !errors.Is(err, errUnknownKey) {
		return payload, err
	}

	// The key may be new (rotation). Refetch, subject to the rate limit, or
	// wait for the refetch already in flight.
	keys, _, err = keySet.refresh(ctx, fetchedAt, true)
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

// refresh refetches the key set unless it was refetched since observed, or
// the previous attempt was less than minRefreshInterval ago. When a fetch is
// already in flight, refresh waits for it if join is set and otherwise
// returns at once with errRefreshInFlight. It returns the current keys
// either way.
func (keySet *remoteKeySet) refresh(ctx context.Context, observed time.Time, join bool) ([]jose.JSONWebKey, time.Time, error) {
	keySet.mu.Lock()

	keys, fetchedAt := keySet.keys, keySet.fetchedAt
	if fetchedAt.After(observed) {
		keySet.mu.Unlock()

		return keys, fetchedAt, nil
	}

	if call := keySet.inflight; call != nil {
		keySet.mu.Unlock()

		if !join {
			return keys, fetchedAt, errRefreshInFlight
		}

		return wait(ctx, call, keys, fetchedAt)
	}

	now := keySet.now()
	if !keySet.lastAttempt.IsZero() && now.Sub(keySet.lastAttempt) < keySet.minRefreshInterval {
		keySet.mu.Unlock()

		return keys, fetchedAt, errRefreshRateLimited
	}

	keySet.lastAttempt = now
	call := &refresh{done: make(chan struct{})}
	keySet.inflight = call
	keySet.mu.Unlock()

	// A refresh serves every waiting request, so it does not inherit the
	// cancellation of the one that started it.
	go keySet.run(context.WithoutCancel(ctx), call, now)

	return wait(ctx, call, keys, fetchedAt)
}

// wait returns the outcome of call, or the cached keys if call fails or ctx
// ends first.
func wait(ctx context.Context, call *refresh, keys []jose.JSONWebKey, fetchedAt time.Time) ([]jose.JSONWebKey, time.Time, error) {
	select {
	case <-call.done:
		if call.err != nil {
			return keys, fetchedAt, call.err
		}

		return call.keys, call.fetchedAt, nil
	case <-ctx.Done():
		return keys, fetchedAt, ctx.Err()
	}
}

// run performs call, a fetch started at startedAt.
func (keySet *remoteKeySet) run(ctx context.Context, call *refresh, startedAt time.Time) {
	fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	fetched, err := keySet.fetch(fetchCtx)

	keySet.mu.Lock()

	if err == nil {
		keySet.keys = fetched
		keySet.fetchedAt = startedAt
	}

	call.keys, call.fetchedAt, call.err = keySet.keys, keySet.fetchedAt, err
	keySet.inflight = nil
	keySet.mu.Unlock()

	// Recorded before waiters resume, so they observe it.
	keySet.metrics.observeRefresh(keySet.now, startedAt, err)
	close(call.done)

	if err != nil {
		keySet.logger.WarnContext(ctx, "cannot refresh the OIDC issuer's key set", "error", err)

		return
	}

	keySet.logger.InfoContext(ctx, "refreshed the OIDC issuer's key set", "keys", len(fetched))
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
	if err != nil || !jwksURL.IsAbs() {
		return "", fmt.Errorf("OpenID configuration has an invalid jwks_uri %q", document.JWKSURI)
	}

	if err := keySet.checkFetchURL(jwksURL); err != nil {
		return "", fmt.Errorf("OpenID configuration jwks_uri: %w", err)
	}

	return jwksURL.String(), nil
}

func (keySet *remoteKeySet) getJSON(ctx context.Context, target string, value any) error {
	parsed, err := url.Parse(target)
	if err != nil {
		return err
	}

	if err := keySet.checkFetchURL(parsed); err != nil {
		return err
	}

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
