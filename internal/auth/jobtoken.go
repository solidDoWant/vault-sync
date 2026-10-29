package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"

	"connectrpc.com/connect"
)

// NewJobTokenInterceptor authenticates every RPC by a static bearer token
// alone: the job token the export job holds (docs/design/encryption.md,
// "Where the escrow chain lives"). Any other caller, a user's OIDC token
// included, is refused with UNAUTHENTICATED. The tokens are compared in
// constant time, as fixed-size SHA-256 digests so that neither their
// contents nor their lengths leak through timing. An empty token refuses
// every call.
func NewJobTokenInterceptor(token []byte) connect.Interceptor {
	want := sha256.Sum256(token)
	configured := len(token) > 0

	check := func(header string) error {
		presented, ok := BearerToken(header)
		got := sha256.Sum256([]byte(presented))

		if subtle.ConstantTimeCompare(got[:], want[:]) != 1 || !ok || !configured {
			return unauthenticated()
		}

		return nil
	}

	return jobTokenInterceptor{check: check}
}

type jobTokenInterceptor struct {
	check func(header string) error
}

func (interceptor jobTokenInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		if request.Spec().IsClient {
			return next(ctx, request)
		}

		if err := interceptor.check(request.Header().Get("Authorization")); err != nil {
			return nil, err
		}

		return next(ctx, request)
	}
}

func (jobTokenInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (interceptor jobTokenInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		if err := interceptor.check(conn.RequestHeader().Get("Authorization")); err != nil {
			return err
		}

		return next(ctx, conn)
	}
}
