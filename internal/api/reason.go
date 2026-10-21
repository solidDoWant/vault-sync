package api

import (
	"errors"

	"connectrpc.com/connect"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
)

// ReasonError returns a Connect error with code and err's message that
// carries an ErrorDetail naming reason, so clients can tell it apart from
// other errors with the same code without reading the message (#428).
func ReasonError(code connect.Code, reason vaultsyncv1.ErrorReason, err error) *connect.Error {
	connectErr := connect.NewError(code, err)

	// NewErrorDetail only fails for a message that cannot be marshaled,
	// which ErrorDetail always can.
	if detail, detailErr := connect.NewErrorDetail(&vaultsyncv1.ErrorDetail{Reason: reason}); detailErr == nil {
		connectErr.AddDetail(detail)
	}

	return connectErr
}

// ErrorReasonOf returns the reason of the first ErrorDetail err carries, or
// ERROR_REASON_UNSPECIFIED if it carries none.
func ErrorReasonOf(err error) vaultsyncv1.ErrorReason {
	var connectErr *connect.Error
	if !errors.As(err, &connectErr) {
		return vaultsyncv1.ErrorReason_ERROR_REASON_UNSPECIFIED
	}

	for _, detail := range connectErr.Details() {
		value, valueErr := detail.Value()
		if valueErr != nil {
			continue
		}

		if reason, ok := value.(*vaultsyncv1.ErrorDetail); ok {
			return reason.GetReason()
		}
	}

	return vaultsyncv1.ErrorReason_ERROR_REASON_UNSPECIFIED
}
