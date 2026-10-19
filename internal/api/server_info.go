// Package api implements the vaultsync.v1 ConnectRPC services
// (proto/vaultsync/v1).
package api

import (
	"context"

	"connectrpc.com/connect"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/version"
)

// ProtocolVersion is the highest protocol version the server speaks. The
// vaultsync.v1 schema is protocol version 1.
const ProtocolVersion = 1

// ServerInfoService implements vaultsync.v1.ServerInfoService. It requires no
// authentication and reveals nothing about vaults or users, and nothing
// secret: every field is public discovery data derived from configuration,
// so every replica answers the same.
type ServerInfoService struct {
	// MaxRealtimeSubscriptions is the realtime channel's subscription cap
	// per connection, or zero when the channel is not served.
	MaxRealtimeSubscriptions uint32
	// OIDCIssuerURL is the issuer whose access tokens the server accepts.
	OIDCIssuerURL string
	// OIDCClientID is the public OAuth client id the plugin signs in as, or
	// empty when none is advertised.
	OIDCClientID string
}

var _ vaultsyncv1connect.ServerInfoServiceHandler = ServerInfoService{}

// GetServerInfo returns the build version, the protocol version, the limits
// clients need to know and the identity provider to sign in with.
func (service ServerInfoService) GetServerInfo(context.Context, *connect.Request[vaultsyncv1.GetServerInfoRequest]) (*connect.Response[vaultsyncv1.GetServerInfoResponse], error) {
	return connect.NewResponse(&vaultsyncv1.GetServerInfoResponse{
		Version:                  version.String(),
		ProtocolVersion:          ProtocolVersion,
		MaxRealtimeSubscriptions: service.MaxRealtimeSubscriptions,
		OidcIssuerUrl:            service.OIDCIssuerURL,
		OidcClientId:             service.OIDCClientID,
	}), nil
}
