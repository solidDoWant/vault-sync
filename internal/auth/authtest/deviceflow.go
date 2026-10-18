package authtest

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

const (
	deviceAuthorizationPath = "/device"
	deviceApprovalPath      = "/device/approve"
	tokenPath               = "/token"
	revokePath              = "/test/revoke-refresh-tokens"
	deviceCodeGrant         = "urn:ietf:params:oauth:grant-type:device_code"
)

// DeviceFlowOptions configures the fake issuer's device authorization grant.
type DeviceFlowOptions struct {
	// ClientID is the only client the grant accepts. Defaults to
	// DefaultAudience (as with Authentik, the client id is the tokens' aud).
	ClientID string
	// Subject is the sub of the access tokens of an authorization approved
	// without a subject of its own. Defaults to "device-flow-user".
	Subject string
	// AccessTokenLifetime defaults to an hour.
	AccessTokenLifetime time.Duration
	// Interval is the polling interval the device authorization asks for, in
	// seconds. Defaults to 1, so tests do not wait the RFC's 5 seconds.
	Interval int
}

// DeviceFlow is the fake issuer's OAuth 2.0 Device Authorization Grant
// (RFC 8628) and refresh-token grant. Nobody types the user code into a
// browser: a test approves it with Approve, or by POSTing user_code to
// /device/approve on the issuer. Access tokens are signed with the key the
// flow was enabled with; refresh tokens are opaque and can be revoked, with
// RevokeRefreshTokens or by POSTing to /test/revoke-refresh-tokens (for
// tests in another process, like the plugin e2e specs).
type DeviceFlow struct {
	issuer  *Issuer
	key     Key
	options DeviceFlowOptions

	mu            sync.Mutex
	devices       map[string]*deviceGrant
	// refreshTokens maps each live refresh token to the subject it was issued to.
	refreshTokens map[string]string
	refreshes     int
}

type deviceGrant struct {
	userCode  string
	expiresAt time.Time
	approved  bool
	subject   string
	redeemed  bool
}

// EnableDeviceFlow adds the device-flow and token endpoints to the issuer and
// advertises them in its OpenID configuration.
func (issuer *Issuer) EnableDeviceFlow(t testing.TB, key Key, options DeviceFlowOptions) *DeviceFlow {
	t.Helper()

	if options.ClientID == "" {
		options.ClientID = DefaultAudience
	}

	if options.Subject == "" {
		options.Subject = "device-flow-user"
	}

	if options.AccessTokenLifetime == 0 {
		options.AccessTokenLifetime = time.Hour
	}

	if options.Interval == 0 {
		options.Interval = 1
	}

	flow := &DeviceFlow{issuer: issuer, key: key, options: options, devices: map[string]*deviceGrant{}, refreshTokens: map[string]string{}}

	issuer.mu.Lock()
	issuer.deviceFlow = flow
	issuer.mu.Unlock()

	issuer.mux.HandleFunc("POST "+deviceAuthorizationPath, flow.authorize)
	issuer.mux.HandleFunc("POST "+deviceApprovalPath, flow.approveRequest)
	issuer.mux.HandleFunc("POST "+tokenPath, flow.token)
	issuer.mux.HandleFunc("POST "+revokePath, func(writer http.ResponseWriter, _ *http.Request) {
		flow.RevokeRefreshTokens()
		writer.WriteHeader(http.StatusNoContent)
	})

	return flow
}

// Approve approves the pending device authorization showing userCode, as the
// user would in a browser. It reports whether there was one.
func (flow *DeviceFlow) Approve(userCode string) bool {
	return flow.ApproveAs(userCode, "")
}

// ApproveAs approves the pending device authorization showing userCode as
// the user subject, so tests can sign in several users. An empty subject is
// DeviceFlowOptions.Subject. It reports whether there was such an
// authorization.
func (flow *DeviceFlow) ApproveAs(userCode, subject string) bool {
	flow.mu.Lock()
	defer flow.mu.Unlock()

	if subject == "" {
		subject = flow.options.Subject
	}

	for _, grant := range flow.devices {
		if grant.userCode == userCode && !grant.redeemed {
			grant.approved = true
			grant.subject = subject

			return true
		}
	}

	return false
}

// RevokeRefreshTokens revokes every refresh token issued so far.
func (flow *DeviceFlow) RevokeRefreshTokens() {
	flow.mu.Lock()
	defer flow.mu.Unlock()

	clear(flow.refreshTokens)
}

// Refreshes is the number of refresh-token grants served so far.
func (flow *DeviceFlow) Refreshes() int {
	flow.mu.Lock()
	defer flow.mu.Unlock()

	return flow.refreshes
}

func (flow *DeviceFlow) authorize(writer http.ResponseWriter, request *http.Request) {
	if request.PostFormValue("client_id") != flow.options.ClientID {
		writeOAuthError(writer, http.StatusUnauthorized, "invalid_client")

		return
	}

	deviceCode := randomHex(16)
	userCode := fmt.Sprintf("%s-%s", randomHex(2), randomHex(2))

	flow.mu.Lock()
	flow.devices[deviceCode] = &deviceGrant{userCode: userCode, expiresAt: time.Now().Add(10 * time.Minute)}
	flow.mu.Unlock()

	writeJSON(writer, map[string]any{
		"device_code":               deviceCode,
		"user_code":                 userCode,
		"verification_uri":          flow.issuer.URL + deviceAuthorizationPath,
		"verification_uri_complete": flow.issuer.URL + deviceAuthorizationPath + "?user_code=" + userCode,
		"expires_in":                600,
		"interval":                  flow.options.Interval,
	})
}

func (flow *DeviceFlow) approveRequest(writer http.ResponseWriter, request *http.Request) {
	if !flow.ApproveAs(request.PostFormValue("user_code"), request.PostFormValue("subject")) {
		http.Error(writer, "no pending authorization with this user code", http.StatusNotFound)

		return
	}

	writer.WriteHeader(http.StatusNoContent)
}

func (flow *DeviceFlow) token(writer http.ResponseWriter, request *http.Request) {
	if request.PostFormValue("client_id") != flow.options.ClientID {
		writeOAuthError(writer, http.StatusUnauthorized, "invalid_client")

		return
	}

	switch request.PostFormValue("grant_type") {
	case deviceCodeGrant:
		flow.redeemDevice(writer, request.PostFormValue("device_code"))
	case "refresh_token":
		flow.redeemRefresh(writer, request.PostFormValue("refresh_token"))
	default:
		writeOAuthError(writer, http.StatusBadRequest, "unsupported_grant_type")
	}
}

func (flow *DeviceFlow) redeemDevice(writer http.ResponseWriter, deviceCode string) {
	flow.mu.Lock()
	grant, ok := flow.devices[deviceCode]

	var (
		problem string
		subject string
	)

	switch {
	case !ok || grant.redeemed:
		problem = "invalid_grant"
	case time.Now().After(grant.expiresAt):
		problem = "expired_token"
	case !grant.approved:
		problem = "authorization_pending"
	default:
		grant.redeemed = true
		subject = grant.subject
	}
	flow.mu.Unlock()

	if problem != "" {
		writeOAuthError(writer, http.StatusBadRequest, problem)

		return
	}

	flow.issueTokens(writer, subject)
}

func (flow *DeviceFlow) redeemRefresh(writer http.ResponseWriter, refreshToken string) {
	flow.mu.Lock()
	flow.refreshes++
	subject, valid := flow.refreshTokens[refreshToken]
	flow.mu.Unlock()

	if !valid {
		writeOAuthError(writer, http.StatusBadRequest, "invalid_grant")

		return
	}

	flow.issueTokens(writer, subject)
}

func (flow *DeviceFlow) issueTokens(writer http.ResponseWriter, subject string) {
	now := time.Now()
	claims := flow.issuer.Claims(subject, now)
	claims["exp"] = now.Add(flow.options.AccessTokenLifetime).Unix()

	accessToken, err := signClaims(flow.key, claims)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)

		return
	}

	refreshToken := randomHex(16)

	flow.mu.Lock()
	flow.refreshTokens[refreshToken] = subject
	flow.mu.Unlock()

	writeJSON(writer, map[string]any{
		"access_token":  accessToken,
		"token_type":    "Bearer",
		"expires_in":    int(flow.options.AccessTokenLifetime.Seconds()),
		"refresh_token": refreshToken,
	})
}

func signClaims(key Key, claims map[string]any) (string, error) {
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: key.Algorithm, Key: jose.JSONWebKey{Key: key.Private, KeyID: key.ID}},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	if err != nil {
		return "", err
	}

	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}

	signed, err := signer.Sign(payload)
	if err != nil {
		return "", err
	}

	return signed.CompactSerialize()
}

func writeOAuthError(writer http.ResponseWriter, status int, code string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]string{"error": code})
}

func randomHex(size int) string {
	buffer := make([]byte, size)
	_, _ = rand.Read(buffer)

	return hex.EncodeToString(buffer)
}
