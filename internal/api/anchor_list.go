package api

import (
	"context"
	"errors"
	"fmt"
	"math"

	"connectrpc.com/connect"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// MaxSealedAnchorListBytes bounds a sealed anchor list: the sealed size of
// the most anchors a list may hold.
const MaxSealedAnchorListBytes = e2ee.MaxSealedAnchorListSize

// GetAnchorList returns the caller's sealed anchor list and its version.
func (service UserKeyService) GetAnchorList(ctx context.Context, _ *connect.Request[vaultsyncv1.GetAnchorListRequest]) (*connect.Response[vaultsyncv1.GetAnchorListResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	list, err := service.Store.AnchorList(ctx, user.ID)
	if err != nil {
		return nil, service.storeError(ctx, "cannot read anchor list", err)
	}

	return connect.NewResponse(&vaultsyncv1.GetAnchorListResponse{Version: list.Version, SealedList: list.SealedList}), nil
}

// PutAnchorList stores the next version of the caller's sealed anchor list.
func (service UserKeyService) PutAnchorList(ctx context.Context, request *connect.Request[vaultsyncv1.PutAnchorListRequest]) (*connect.Response[vaultsyncv1.PutAnchorListResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	message := request.Msg

	if message.GetVersion() == 0 || message.GetVersion() > math.MaxInt64 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("version must be 1 to %d", int64(math.MaxInt64)))
	}

	if len(message.GetSealedList()) == 0 || len(message.GetSealedList()) > MaxSealedAnchorListBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("sealed_list must be 1 to %d bytes", MaxSealedAnchorListBytes))
	}

	if err := service.Store.PutAnchorList(ctx, user.ID, message.GetVersion(), message.GetSealedList()); err != nil {
		if errors.Is(err, store.ErrAnchorListVersion) {
			return nil, connect.NewError(connect.CodeFailedPrecondition,
				errors.New("version is not the stored version plus one"))
		}

		return nil, service.storeError(ctx, "cannot store anchor list", err)
	}

	return connect.NewResponse(&vaultsyncv1.PutAnchorListResponse{}), nil
}
