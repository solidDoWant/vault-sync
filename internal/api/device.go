package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Device registration bounds.
const (
	// MaxDeviceNameBytes bounds a device name (UTF-8 bytes).
	MaxDeviceNameBytes = 256
	// PublicKeyBytes is the size of an X25519 public key.
	PublicKeyBytes = 32
	// MaxDevicesPerUser bounds how many devices one user may register.
	MaxDevicesPerUser = 100
)

// DeviceStore persists devices. *store.Store implements it.
type DeviceStore interface {
	RegisterDevice(ctx context.Context, userID uuid.UUID, name string, publicKey []byte, limit int) (store.Device, error)
}

// DeviceService implements vaultsync.v1.DeviceService for the authenticated
// caller.
type DeviceService struct {
	Devices DeviceStore
	// Logger receives internal errors, which are not returned to callers.
	Logger *slog.Logger
}

var _ vaultsyncv1connect.DeviceServiceHandler = DeviceService{}

// RegisterDevice registers a device for the caller.
func (service DeviceService) RegisterDevice(ctx context.Context, request *connect.Request[vaultsyncv1.RegisterDeviceRequest]) (*connect.Response[vaultsyncv1.RegisterDeviceResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	name := request.Msg.GetName()
	if strings.TrimSpace(name) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must not be empty"))
	}

	if len(name) > MaxDeviceNameBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("name must be at most %d bytes", MaxDeviceNameBytes))
	}

	publicKey := request.Msg.GetPublicKey()
	if len(publicKey) != 0 && len(publicKey) != PublicKeyBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("public_key must be empty or exactly %d bytes", PublicKeyBytes))
	}

	device, err := service.Devices.RegisterDevice(ctx, user.ID, name, publicKey, MaxDevicesPerUser)
	if err != nil {
		if errors.Is(err, store.ErrDeviceLimit) {
			return nil, connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("at most %d devices may be registered", MaxDevicesPerUser))
		}

		service.Logger.ErrorContext(ctx, "cannot register device", "error", err)

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot register device"))
	}

	return connect.NewResponse(&vaultsyncv1.RegisterDeviceResponse{
		Device: &vaultsyncv1.Device{
			Id:         device.ID.String(),
			Name:       device.Name,
			CreateTime: timestamppb.New(device.CreatedAt),
		},
	}), nil
}
