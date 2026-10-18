// Package auth authenticates API callers with OIDC access tokens (SPEC.md
// §9.1). Access tokens are JWTs validated against the issuer's JSON Web Key
// Set; the first authenticated request of a new identity creates its user
// (just-in-time provisioning).
//
// Tokens and claims are never logged.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
)

// Token validation bounds.
const (
	// MaxTokenBytes bounds a token before it is parsed.
	MaxTokenBytes = 16 << 10
	// MaxSubjectBytes bounds the sub claim stored for a user.
	MaxSubjectBytes = 255
	// NotBeforeLeeway tolerates issuer clock skew on the nbf claim. exp is
	// checked without leeway.
	NotBeforeLeeway = time.Minute

	// DefaultMinRefreshInterval is the minimum time between two fetches of
	// the issuer's key set.
	DefaultMinRefreshInterval = 30 * time.Second
	// DefaultMaxKeyAge is how long fetched keys are used before they are
	// refetched, so that keys the issuer withdrew stop being trusted.
	DefaultMaxKeyAge = time.Hour
)

// ErrUnauthenticated is returned (wrapped) for any missing, malformed or
// invalid token. Its message is safe to return to the caller.
var ErrUnauthenticated = errors.New("missing or invalid bearer token")

// Identity is the verified identity a token asserts.
type Identity struct {
	Issuer  string
	Subject string
}

// VerifierOptions configures a Verifier.
type VerifierOptions struct {
	// IssuerURL is the issuer identifier; tokens' iss must equal it exactly.
	// The key set is discovered from IssuerURL/.well-known/openid-configuration.
	IssuerURL string
	// Audience must appear in tokens' aud.
	Audience string
	// HTTPClient fetches the discovery document and key set. Defaults to a
	// client with a 10 second timeout. The Verifier uses a copy whose
	// redirect policy also refuses redirects to another host or from https
	// to http.
	HTTPClient *http.Client
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
	// MinRefreshInterval defaults to DefaultMinRefreshInterval.
	MinRefreshInterval time.Duration
	// MaxKeyAge defaults to DefaultMaxKeyAge.
	MaxKeyAge time.Duration
	// Logger defaults to discarding logs.
	Logger *slog.Logger
}

// Verifier validates OIDC access tokens: signature (with an allowed
// algorithm, against the issuer's key set), iss, aud, exp and nbf.
type Verifier struct {
	verifier *oidc.IDTokenVerifier
	now      func() time.Time
}

// NewVerifier builds a Verifier. It makes no network requests; the key set
// is fetched on first use.
func NewVerifier(options VerifierOptions) *Verifier {
	if options.HTTPClient == nil {
		options.HTTPClient = &http.Client{Timeout: fetchTimeout}
	}

	if options.Now == nil {
		options.Now = time.Now
	}

	if options.MinRefreshInterval <= 0 {
		options.MinRefreshInterval = DefaultMinRefreshInterval
	}

	if options.MaxKeyAge <= 0 {
		options.MaxKeyAge = DefaultMaxKeyAge
	}

	if options.Logger == nil {
		options.Logger = slog.New(slog.DiscardHandler)
	}

	keySet := newRemoteKeySet(options)

	return &Verifier{
		verifier: oidc.NewVerifier(options.IssuerURL, keySet, &oidc.Config{
			ClientID:             options.Audience,
			SupportedSigningAlgs: AllowedAlgorithms,
			Now:                  options.Now,
		}),
		now: options.Now,
	}
}

// Verify validates token and returns the identity it asserts. Every
// rejection wraps ErrUnauthenticated.
func (verifier *Verifier) Verify(ctx context.Context, token string) (Identity, error) {
	if token == "" {
		return Identity{}, fmt.Errorf("%w: no token", ErrUnauthenticated)
	}

	if len(token) > MaxTokenBytes {
		return Identity{}, fmt.Errorf("%w: token exceeds %d bytes", ErrUnauthenticated, MaxTokenBytes)
	}

	verified, err := verifier.verifier.Verify(ctx, token)
	if err != nil {
		var expired *oidc.TokenExpiredError
		if errors.As(err, &expired) {
			return Identity{}, fmt.Errorf("%w: token expired", ErrUnauthenticated)
		}

		// The underlying error can quote claims; it is not passed on.
		return Identity{}, fmt.Errorf("%w: token failed verification", ErrUnauthenticated)
	}

	// go-oidc tolerates five minutes of nbf skew; enforce a tighter bound.
	var claims struct {
		NotBefore *json.Number `json:"nbf"`
	}

	if err := verified.Claims(&claims); err != nil {
		return Identity{}, fmt.Errorf("%w: malformed claims", ErrUnauthenticated)
	}

	if claims.NotBefore != nil {
		notBefore, err := claims.NotBefore.Float64()
		if err != nil {
			return Identity{}, fmt.Errorf("%w: malformed nbf claim", ErrUnauthenticated)
		}

		if float64(verifier.now().Add(NotBeforeLeeway).Unix()) < notBefore {
			return Identity{}, fmt.Errorf("%w: token not yet valid", ErrUnauthenticated)
		}
	}

	if verified.Subject == "" || len(verified.Subject) > MaxSubjectBytes {
		return Identity{}, fmt.Errorf("%w: missing or over-long sub claim", ErrUnauthenticated)
	}

	return Identity{Issuer: verified.Issuer, Subject: verified.Subject}, nil
}

// TokenVerifier validates a token. *Verifier implements it.
type TokenVerifier interface {
	Verify(ctx context.Context, token string) (Identity, error)
}

// UserStore provisions users. *store.Store implements it.
type UserStore interface {
	// UpsertUser returns the id of the user with the given OIDC identity,
	// creating the user if it does not exist. It is safe to call
	// concurrently for the same new identity.
	UpsertUser(ctx context.Context, issuer, subject string) (uuid.UUID, error)
}

// User is an authenticated caller.
type User struct {
	ID       uuid.UUID
	Identity Identity
}

// Authenticator turns bearer tokens into users. It is shared by the RPC
// interceptor and the realtime WebSocket upgrade.
type Authenticator struct {
	verifier TokenVerifier
	users    UserStore
}

// NewAuthenticator builds an Authenticator.
func NewAuthenticator(verifier TokenVerifier, users UserStore) *Authenticator {
	return &Authenticator{verifier: verifier, users: users}
}

// AuthenticateToken validates token and returns its user, creating the user
// on first sight. Token problems wrap ErrUnauthenticated; any other error
// means the user could not be loaded.
func (authenticator *Authenticator) AuthenticateToken(ctx context.Context, token string) (User, error) {
	identity, err := authenticator.verifier.Verify(ctx, token)
	if err != nil {
		if !errors.Is(err, ErrUnauthenticated) {
			err = fmt.Errorf("%w: %w", ErrUnauthenticated, err)
		}

		return User{}, err
	}

	id, err := authenticator.users.UpsertUser(ctx, identity.Issuer, identity.Subject)
	if err != nil {
		return User{}, fmt.Errorf("load user: %w", err)
	}

	return User{ID: id, Identity: identity}, nil
}

// AuthenticateHeader authenticates the value of an HTTP Authorization header,
// which must use the Bearer scheme.
func (authenticator *Authenticator) AuthenticateHeader(ctx context.Context, header string) (User, error) {
	token, ok := BearerToken(header)
	if !ok {
		return User{}, fmt.Errorf("%w: no bearer token", ErrUnauthenticated)
	}

	return authenticator.AuthenticateToken(ctx, token)
}

// BearerToken extracts the token from an Authorization header value.
func BearerToken(header string) (string, bool) {
	scheme, token, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}

	token = strings.TrimSpace(token)

	return token, token != ""
}

type userKey struct{}

// WithUser returns a context carrying user.
func WithUser(ctx context.Context, user User) context.Context {
	return context.WithValue(ctx, userKey{}, user)
}

// UserFromContext returns the authenticated user stored in ctx.
func UserFromContext(ctx context.Context) (User, bool) {
	user, ok := ctx.Value(userKey{}).(User)

	return user, ok
}
