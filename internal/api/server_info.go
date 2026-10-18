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
// authentication and reveals nothing about vaults or users.
type ServerInfoService struct{}

var _ vaultsyncv1connect.ServerInfoServiceHandler = ServerInfoService{}

// GetServerInfo returns the build version and protocol version.
func (ServerInfoService) GetServerInfo(context.Context, *connect.Request[vaultsyncv1.GetServerInfoRequest]) (*connect.Response[vaultsyncv1.GetServerInfoResponse], error) {
	return connect.NewResponse(&vaultsyncv1.GetServerInfoResponse{
		Version:         version.String(),
		ProtocolVersion: ProtocolVersion,
	}), nil
}
