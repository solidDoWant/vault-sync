package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"connectrpc.com/connect"
)

// Interceptor authenticates every RPC except those on an explicit public
// allow-list. It is default-deny: a procedure that is not on the list is
// authenticated, and with a nil Authenticator every such procedure is
// rejected.
type Interceptor struct {
	authenticator *Authenticator
	public        map[string]bool
	logger        *slog.Logger
}

var _ connect.Interceptor = (*Interceptor)(nil)

// NewInterceptor builds an Interceptor. publicProcedures are full procedure
// names (for example "/vaultsync.v1.ServerInfoService/GetServerInfo").
func NewInterceptor(authenticator *Authenticator, publicProcedures []string, logger *slog.Logger) *Interceptor {
	public := make(map[string]bool, len(publicProcedures))
	for _, procedure := range publicProcedures {
		public[procedure] = true
	}

	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}

	return &Interceptor{authenticator: authenticator, public: public, logger: logger}
}

func (interceptor *Interceptor) authenticate(ctx context.Context, procedure string, header http.Header) (context.Context, error) {
	if interceptor.public[procedure] {
		return ctx, nil
	}

	if interceptor.authenticator == nil {
		return nil, unauthenticated()
	}

	user, err := interceptor.authenticator.AuthenticateHeader(ctx, header.Get("Authorization"))
	if err != nil {
		if errors.Is(err, ErrUnauthenticated) {
			// err names the reason (expired, failed verification, ...) and
			// never contains the token or its claims.
			interceptor.logger.DebugContext(ctx, "rejected unauthenticated request", "procedure", procedure, "reason", err.Error())

			return nil, unauthenticated()
		}

		interceptor.logger.ErrorContext(ctx, "cannot authenticate request", "procedure", procedure, "error", err)

		return nil, connect.NewError(connect.CodeUnavailable, errors.New("authentication is temporarily unavailable"))
	}

	return WithUser(ctx, user), nil
}

func unauthenticated() error {
	connectErr := connect.NewError(connect.CodeUnauthenticated, ErrUnauthenticated)
	connectErr.Meta().Set("WWW-Authenticate", `Bearer`)

	return connectErr
}

// WrapUnary authenticates unary RPCs.
func (interceptor *Interceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		if request.Spec().IsClient {
			return next(ctx, request)
		}

		ctx, err := interceptor.authenticate(ctx, request.Spec().Procedure, request.Header())
		if err != nil {
			return nil, err
		}

		return next(ctx, request)
	}
}

// WrapStreamingClient leaves client streams unchanged.
func (interceptor *Interceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

// WrapStreamingHandler authenticates streaming RPCs.
func (interceptor *Interceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		ctx, err := interceptor.authenticate(ctx, conn.Spec().Procedure, conn.RequestHeader())
		if err != nil {
			return err
		}

		return next(ctx, conn)
	}
}
