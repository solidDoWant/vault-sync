// Package api implements the vaultsync.v1 ConnectRPC services
// (proto/vaultsync/v1).
package api

import (
	"context"
	"slices"

	"connectrpc.com/connect"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
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
	// Escrow is the deployment's escrow key and default, published to
	// clients (SPEC.md §9.4).
	Escrow Escrow
}

// Escrow is the deployment's escrow public key (SPEC.md §9.4), which
// clients wrap every epoch key of an escrow vault to, and whether new
// end-to-end encrypted vaults have escrow by default. The escrow private key
// is never part of the server's configuration.
type Escrow struct {
	// PublicKey is the 1216-byte hybrid public key, or nil when the
	// deployment has no escrow key.
	PublicKey []byte
	// KeyID names PublicKey in escrow key slots (e2ee.EscrowKeyID).
	KeyID string
	// RetiringKeyIDs are the ids of escrow keys being rotated away from,
	// which escrow slots may still name until the rotation ends.
	RetiringKeyIDs []string
	// Default is whether a new encrypted vault has escrow unless its owner
	// turns it off. It is published as false without a PublicKey.
	Default bool
	// Bundle is the configured escrow bundle: the escrow signing public key
	// and the recipient PublicKey was parsed from. Nil when the deployment
	// has no escrow key.
	Bundle *e2ee.EscrowBundle
	// Chain is the deployment's escrow chain, whose head is Bundle. The
	// server reads and checks it at startup.
	Chain EscrowChain
	// Rotations are Chain's rotation statements, parsed. Log replays take
	// them, so that an escrow entry moving a vault to a later key of the
	// chain verifies.
	Rotations []e2ee.EscrowRotation
}

// replayOptions are what the server replays a vault's membership log with:
// the deployment's escrow chain.
func (escrow Escrow) replayOptions() e2ee.ReplayOptions {
	return e2ee.ReplayOptions{EscrowRotations: escrow.Rotations}
}

// EscrowChain is the deployment's escrow chain (docs/design/encryption.md,
// "Where the escrow chain lives"), encoded as published: the root escrow
// bundle and the rotation statements after it.
type EscrowChain struct {
	Root      []byte
	Rotations []*vaultsyncv1.EscrowRotationStatement
}

// AcceptsSlot reports whether an escrow slot may name recipientID: the
// current escrow key id, or a retiring one. Without an escrow key, no id is
// accepted.
func (escrow Escrow) AcceptsSlot(recipientID string) bool {
	if !escrow.Configured() {
		return false
	}

	return recipientID == escrow.KeyID || slices.Contains(escrow.RetiringKeyIDs, recipientID)
}

// Configured reports whether the deployment has an escrow key.
func (escrow Escrow) Configured() bool {
	return len(escrow.PublicKey) > 0
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
		EscrowPublicKey:          service.Escrow.PublicKey,
		EscrowKeyId:              service.Escrow.KeyID,
		EscrowDefault:            service.Escrow.Configured() && service.Escrow.Default,
		EscrowRootBundle:         service.Escrow.Chain.Root,
		EscrowRotations:          service.Escrow.Chain.Rotations,
	}), nil
}
