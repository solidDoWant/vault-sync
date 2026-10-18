package auth_test

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
)

// recordingTransport records every request the verifier makes. It serves
// only loopback hosts, so a test never reaches the network.
type recordingTransport struct {
	next http.RoundTripper

	mu       sync.Mutex
	requests []*url.URL
}

func (transport *recordingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.mu.Lock()
	transport.requests = append(transport.requests, request.URL)
	transport.mu.Unlock()

	if ip := net.ParseIP(request.URL.Hostname()); ip == nil || !ip.IsLoopback() {
		return nil, errors.New("recordingTransport: refusing a non-loopback request")
	}

	return transport.next.RoundTrip(request)
}

// requested returns every URL requested so far.
func (transport *recordingTransport) requested() []string {
	transport.mu.Lock()
	defer transport.mu.Unlock()

	urls := make([]string, 0, len(transport.requests))
	for _, requested := range transport.requests {
		urls = append(urls, requested.String())
	}

	return urls
}

// cleartext returns every plain http URL requested so far.
func (transport *recordingTransport) cleartext() []string {
	transport.mu.Lock()
	defer transport.mu.Unlock()

	var urls []string

	for _, requested := range transport.requests {
		if requested.Scheme != "https" {
			urls = append(urls, requested.String())
		}
	}

	return urls
}

// recordingClient returns a client that trusts the TLS fake issuers'
// certificate and records the requests it makes.
func recordingClient(issuer *authtest.Issuer) (*http.Client, *recordingTransport) {
	transport := &recordingTransport{next: issuer.Client().Transport}

	return &http.Client{Transport: transport}, transport
}

func newClientVerifier(issuer *authtest.Issuer, clock *clock, client *http.Client) *auth.Verifier {
	return auth.NewVerifier(auth.VerifierOptions{
		IssuerURL:          issuer.URL,
		Audience:           authtest.DefaultAudience,
		HTTPClient:         client,
		Now:                clock.Now,
		MinRefreshInterval: minRefreshInterval,
		MaxKeyAge:          time.Hour,
	})
}

// redirect answers requests for path with a 302 to the URL target returns.
func redirect(path string, target func(request *http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != path {
				next.ServeHTTP(writer, request)

				return
			}

			http.Redirect(writer, request, target(request), http.StatusFound)
		})
	}
}

func cleartextTarget(request *http.Request) string {
	return "http://" + request.Host + request.URL.Path
}

func TestVerifierRefusesCleartextJWKSURI(t *testing.T) {
	tests := []struct {
		name    string
		jwksURI func(issuer *authtest.Issuer) string
	}{
		{name: "non-loopback host", jwksURI: func(*authtest.Issuer) string { return "http://keys.example.com/jwks" }},
		{name: "non-loopback IP", jwksURI: func(*authtest.Issuer) string { return "http://192.0.2.1/jwks" }},
		// Loopback http is a local-development allowance for loopback http
		// issuers only; an https issuer's keys are never fetched in cleartext.
		{name: "issuer's loopback host", jwksURI: func(issuer *authtest.Issuer) string {
			parsed, err := url.Parse(issuer.URL)
			require.NoError(t, err)

			return "http://" + parsed.Host + "/jwks"
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			issuer := authtest.NewTLSIssuer(t)
			key := issuer.AddKey(t, jose.RS256)
			issuer.SetJWKSURI(test.jwksURI(issuer))

			clock := newClock()
			client, transport := recordingClient(issuer)

			_, err := newClientVerifier(issuer, clock, client).Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
			require.ErrorIs(t, err, auth.ErrUnauthenticated)

			assert.Empty(t, transport.cleartext(), "the key set must not be fetched in cleartext")
			assert.Zero(t, issuer.JWKSRequests())
		})
	}
}

func TestVerifierAcceptsAnHTTPSJWKSURIOnAnotherHost(t *testing.T) {
	issuer := authtest.NewTLSIssuer(t)
	keyHost := authtest.NewTLSIssuer(t)
	key := keyHost.AddKey(t, jose.ES256)
	issuer.SetJWKSURI(keyHost.URL + "/jwks")

	clock := newClock()
	client, _ := recordingClient(issuer)

	_, err := newClientVerifier(issuer, clock, client).Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err)
	assert.Equal(t, 1, keyHost.JWKSRequests())
}

func TestVerifierRefusesRedirectsThatDowngradeOrLeaveTheHost(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		target func(other *authtest.Issuer) func(*http.Request) string
	}{
		{
			name:   "discovery to http on the same host",
			path:   "/.well-known/openid-configuration",
			target: func(*authtest.Issuer) func(*http.Request) string { return cleartextTarget },
		},
		{
			name:   "key set to http on the same host",
			path:   "/jwks",
			target: func(*authtest.Issuer) func(*http.Request) string { return cleartextTarget },
		},
		{
			name: "discovery to http on another host",
			path: "/.well-known/openid-configuration",
			target: func(*authtest.Issuer) func(*http.Request) string {
				return func(*http.Request) string { return "http://keys.example.com/.well-known/openid-configuration" }
			},
		},
		{
			name: "key set to https on another host",
			path: "/jwks",
			target: func(other *authtest.Issuer) func(*http.Request) string {
				return func(*http.Request) string { return other.URL + "/jwks" }
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			issuer := authtest.NewTLSIssuer(t)
			other := authtest.NewTLSIssuer(t)
			key := issuer.AddKey(t, jose.RS256)
			// The other host would serve the key, so following the redirect
			// would authenticate the token.
			other.Publish(key)
			issuer.SetMiddleware(redirect(test.path, test.target(other)))

			clock := newClock()
			client, transport := recordingClient(issuer)

			_, err := newClientVerifier(issuer, clock, client).Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
			require.ErrorIs(t, err, auth.ErrUnauthenticated)

			assert.Empty(t, transport.cleartext(), "a redirect to http must not be followed")
			assert.Zero(t, other.JWKSRequests(), "a redirect to another host must not be followed")
		})
	}
}

func TestVerifierKeepsCachedKeysWhenAKeySetRedirectIsRefused(t *testing.T) {
	issuer := authtest.NewTLSIssuer(t)
	key := issuer.AddKey(t, jose.RS256)
	clock := newClock()
	client, transport := recordingClient(issuer)
	verifier := newClientVerifier(issuer, clock, client)

	_, err := verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err)
	require.Equal(t, 1, issuer.JWKSRequests())

	issuer.SetMiddleware(redirect("/jwks", cleartextTarget))
	clock.Advance(time.Hour)

	_, err = verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err, "the cached keys stay in use")

	assert.Empty(t, transport.cleartext(), "a redirect to http must not be followed")
	assert.Contains(t, transport.requested(), issuer.URL+"/jwks", "the refresh was attempted")
	assert.Equal(t, 1, issuer.JWKSRequests())
}

func TestVerifierFollowsSameHostRedirects(t *testing.T) {
	tests := []struct {
		name      string
		newIssuer func(testing.TB) *authtest.Issuer
	}{
		{name: "https", newIssuer: authtest.NewTLSIssuer},
		{name: "loopback http", newIssuer: authtest.NewIssuer},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			issuer := test.newIssuer(t)
			key := issuer.AddKey(t, jose.EdDSA)
			issuer.SetMiddleware(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
					if request.URL.RawQuery == "" {
						http.Redirect(writer, request, request.URL.Path+"?moved=1", http.StatusMovedPermanently)

						return
					}

					next.ServeHTTP(writer, request)
				})
			})

			clock := newClock()
			client, transport := recordingClient(issuer)

			_, err := newClientVerifier(issuer, clock, client).Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
			require.NoError(t, err)
			assert.Len(t, transport.requested(), 4, "discovery and key set, each redirected once")
		})
	}
}

func TestVerifierAllowsCleartextOnlyForLoopbackIssuers(t *testing.T) {
	tests := []struct {
		name        string
		jwksURI     func(issuer *authtest.Issuer) string
		assertError require.ErrorAssertionFunc
	}{
		{name: "issuer's own jwks_uri", jwksURI: func(issuer *authtest.Issuer) string { return issuer.URL + "/jwks" }},
		{name: "localhost", jwksURI: func(issuer *authtest.Issuer) string {
			parsed, err := url.Parse(issuer.URL)
			require.NoError(t, err)

			return "http://localhost:" + parsed.Port() + "/jwks"
		}},
		{
			name:        "non-loopback host",
			jwksURI:     func(*authtest.Issuer) string { return "http://keys.example.com/jwks" },
			assertError: requireUnauthenticated,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.assertError == nil {
				test.assertError = require.NoError
			}

			issuer := authtest.NewIssuer(t)
			key := issuer.AddKey(t, jose.RS256)
			issuer.SetJWKSURI(test.jwksURI(issuer))

			clock := newClock()
			transport := &recordingTransport{next: http.DefaultTransport}
			// localhost resolves locally; the recording transport would
			// refuse it as a non-IP host, so it is let through here.
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.URL.Hostname() == "localhost" {
					return http.DefaultTransport.RoundTrip(request)
				}

				return transport.RoundTrip(request)
			})}

			_, err := newClientVerifier(issuer, clock, client).Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
			test.assertError(t, err)

			for _, requested := range transport.requested() {
				assert.NotContains(t, requested, "example.com", "a cleartext key set on a non-loopback host must not be fetched")
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

// stall makes the issuer's key set endpoint hang until the returned release
// function is called (or the test ends). Each stalled request is announced
// on entered.
func stall(t *testing.T, issuer *authtest.Issuer) (entered <-chan struct{}, release func()) {
	t.Helper()

	enteredChannel := make(chan struct{}, 100)
	released := make(chan struct{})

	var once sync.Once

	release = func() { once.Do(func() { close(released) }) }
	// Registered after the issuer, so it runs before the issuer's server is
	// closed (which waits for the stalled requests).
	t.Cleanup(release)

	issuer.SetMiddleware(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/jwks" {
				enteredChannel <- struct{}{}

				select {
				case <-released:
				case <-request.Context().Done():
					return
				}
			}

			next.ServeHTTP(writer, request)
		})
	})

	return enteredChannel, release
}

func waitFor(t *testing.T, channel <-chan struct{}, what string) {
	t.Helper()

	select {
	case <-channel:
	case <-time.After(5 * time.Second):
		require.FailNow(t, "timed out waiting for "+what)
	}
}

func TestVerifierServesCachedKeysWhileARefreshHangs(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)
	clock := newClock()
	verifier := newVerifier(issuer, clock)

	_, err := verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err)

	entered, release := stall(t, issuer)

	clock.Advance(time.Hour)

	// The first request after the keys went stale starts a refresh, which
	// hangs.
	initiator := make(chan error, 1)

	go func() {
		_, err := verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
		initiator <- err
	}()

	waitFor(t, entered, "the refresh to start")

	// Every other request is served from the cached keys meanwhile.
	done := make(chan struct{})

	go func() {
		defer close(done)

		var group sync.WaitGroup

		for range 20 {
			group.Go(func() {
				_, err := verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("bob", clock.Now())))
				assert.NoError(t, err)
			})
		}

		group.Wait()
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		// Unblock the stalled requests before failing, so none of them
		// outlives the test.
		release()
		<-done
		require.FailNow(t, "requests waited for the hanging refresh")
	}

	release()
	require.NoError(t, <-initiator)
	assert.Len(t, entered, 0, "a single refresh was started")
	assert.Equal(t, 2, issuer.JWKSRequests())
}

func TestVerifierUnknownKeyIDWaitsForTheRefreshInFlight(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	oldKey := issuer.AddKey(t, jose.RS256)
	clock := newClock()
	verifier := newVerifier(issuer, clock)

	_, err := verifier.Verify(t.Context(), authtest.Sign(t, oldKey, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err)

	entered, release := stall(t, issuer)

	clock.Advance(time.Hour)

	initiator := make(chan error, 1)

	go func() {
		_, err := verifier.Verify(t.Context(), authtest.Sign(t, oldKey, issuer.Claims("alice", clock.Now())))
		initiator <- err
	}()

	waitFor(t, entered, "the refresh to start")

	// The issuer rotates while the refresh is in flight.
	newKey := issuer.AddKey(t, jose.EdDSA)
	rotated := make(chan error, 1)

	go func() {
		_, err := verifier.Verify(t.Context(), authtest.Sign(t, newKey, issuer.Claims("bob", clock.Now())))
		rotated <- err
	}()

	release()
	require.NoError(t, <-initiator)
	require.NoError(t, <-rotated, "the new key arrives with the refresh in flight")
	assert.Equal(t, 2, issuer.JWKSRequests(), "no second refresh is started")

	// Another unknown kid within the interval does not refresh again.
	_, err = verifier.Verify(t.Context(), authtest.Sign(t, authtest.NewKey(t, jose.EdDSA), issuer.Claims("mallory", clock.Now())))
	require.ErrorIs(t, err, auth.ErrUnauthenticated)
	assert.Equal(t, 2, issuer.JWKSRequests())
	assert.Len(t, entered, 0)
}
