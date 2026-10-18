package realtime

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Disconnect reasons, the reason label of the disconnects metric.
const (
	reasonClient        = "client"
	reasonDrain         = "drain"
	reasonSlowClient    = "slow_client"
	reasonRateLimit     = "rate_limit"
	reasonInvalidFrame  = "invalid_frame"
	reasonTokenExpired  = "token_expired"
	reasonPingTimeout   = "ping_timeout"
	reasonWriteFailed   = "write_failed"
	reasonFrameTooLarge = "frame_too_large"
)

// closeRequest is a graceful close: an optional final frame, then a close
// frame with code and reason.
type closeRequest struct {
	code    websocket.StatusCode
	text    string
	reason  string
	errCode vaultsyncv1.ErrorCode
	message string
}

var (
	closeGoingAway = closeRequest{code: websocket.StatusGoingAway, text: "server shutting down", reason: reasonDrain}
	closeExpired   = closeRequest{
		code: websocket.StatusPolicyViolation, text: "token expired", reason: reasonTokenExpired,
		errCode: vaultsyncv1.ErrorCode_ERROR_CODE_UNAUTHENTICATED, message: "access token expired; reconnect with a fresh token",
	}
	closeRateLimit = closeRequest{
		code: websocket.StatusPolicyViolation, text: "frame rate exceeded", reason: reasonRateLimit,
		errCode: vaultsyncv1.ErrorCode_ERROR_CODE_RESOURCE_EXHAUSTED, message: "frame rate limit exceeded",
	}
	closeTextFrame = closeRequest{
		code: websocket.StatusUnsupportedData, text: "binary frames only", reason: reasonInvalidFrame,
		errCode: vaultsyncv1.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, message: "frames must be binary protobuf ClientFrames",
	}
	closeMalformed = closeRequest{
		code: websocket.StatusInvalidFramePayloadData, text: "malformed frame", reason: reasonInvalidFrame,
		errCode: vaultsyncv1.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, message: "frame is not a valid ClientFrame",
	}
)

// connection is one client's WebSocket.
type connection struct {
	hub  *Hub
	user auth.User
	ws   *websocket.Conn

	// ctx ends when the connection ends.
	ctx    context.Context
	cancel context.CancelFunc

	// send queues frames for the writer; it is never closed.
	send chan *vaultsyncv1.ServerFrame

	// closing is closed, once, when a graceful close is requested.
	closing   chan struct{}
	endOnce   sync.Once
	closeWith closeRequest
	endReason string

	limiter *tokenBucket

	// subscriptions is guarded by hub.mu.
	subscriptions map[uuid.UUID]*subscription
}

// ServeHTTP upgrades an authenticated request to the realtime WebSocket. It
// refuses the upgrade with 403 for a disallowed Origin, 401 for a missing or
// invalid token, 400 when the client does not offer Subprotocol, 429 when the
// user has too many connections, and 503 when this instance is full or
// draining.
func (hub *Hub) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	ctx := request.Context()

	if origin := request.Header.Values("Origin"); len(origin) > 0 && (len(origin) > 1 || !hub.origins[origin[0]]) {
		hub.refuse(writer, http.StatusForbidden, "origin not allowed", "origin")

		return
	}

	protocols := offeredSubprotocols(request.Header)

	token, ok := bearerToken(request.Header, protocols)
	if !ok || hub.options.Authenticator == nil {
		hub.refuseUnauthenticated(writer)

		return
	}

	user, err := hub.options.Authenticator.AuthenticateToken(ctx, token)
	if err != nil {
		if errors.Is(err, auth.ErrUnauthenticated) {
			// err names the reason and never contains the token.
			hub.logger.DebugContext(ctx, "refused unauthenticated realtime upgrade", "reason", err.Error())
			hub.refuseUnauthenticated(writer)

			return
		}

		hub.logger.ErrorContext(ctx, "cannot authenticate realtime upgrade", "error", err)
		hub.refuse(writer, http.StatusServiceUnavailable, "authentication is temporarily unavailable", "unavailable")

		return
	}

	if !protocols[Subprotocol] {
		hub.refuse(writer, http.StatusBadRequest, "the "+Subprotocol+" subprotocol is required", "protocol")

		return
	}

	switch hub.admit(user.ID) {
	case admitted:
	case refusedUserLimit:
		hub.refuse(writer, http.StatusTooManyRequests, "too many realtime connections for this user", "user_limit")

		return
	case refusedInstanceLimit:
		hub.refuse(writer, http.StatusServiceUnavailable, "too many realtime connections", "instance_limit")

		return
	case refusedDraining:
		hub.refuse(writer, http.StatusServiceUnavailable, "server shutting down", "draining")

		return
	}
	defer hub.release(user.ID)

	// The HTTP server's read deadline (and any write deadline) would
	// otherwise stay on the hijacked connection and cut it off.
	controller := http.NewResponseController(writer)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})

	// Origin was checked above, against the exact allowed origins.
	ws, err := websocket.Accept(writer, request, &websocket.AcceptOptions{
		Subprotocols:       []string{Subprotocol},
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		// Accept has written the response; err may quote request headers.
		hub.logger.DebugContext(ctx, "realtime upgrade failed")

		return
	}

	ws.SetReadLimit(hub.limits.MaxFrameBytes)

	connCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	conn := &connection{
		hub:           hub,
		user:          user,
		ws:            ws,
		ctx:           connCtx,
		cancel:        cancel,
		send:          make(chan *vaultsyncv1.ServerFrame, hub.limits.SendBuffer),
		closing:       make(chan struct{}),
		limiter:       newTokenBucket(hub.limits.FramesPerSecond, hub.limits.MaxSubscriptions+frameBurstSlack, time.Now()),
		subscriptions: make(map[uuid.UUID]*subscription),
	}

	if !hub.register(conn) {
		cancel()

		_ = ws.Close(websocket.StatusGoingAway, closeGoingAway.text)

		return
	}

	started := time.Now()

	conn.run()
	hub.unregister(conn)
	hub.metrics.disconnects.WithLabelValues(conn.endReason).Inc()
	hub.logger.DebugContext(ctx, "realtime connection closed",
		"user_id", user.ID.String(), "reason", conn.endReason, "duration", time.Since(started).String())
}

func (hub *Hub) refuse(writer http.ResponseWriter, status int, message, reason string) {
	hub.metrics.refusals.WithLabelValues(reason).Inc()
	http.Error(writer, message, status)
}

func (hub *Hub) refuseUnauthenticated(writer http.ResponseWriter) {
	writer.Header().Set("WWW-Authenticate", "Bearer")
	hub.refuse(writer, http.StatusUnauthorized, auth.ErrUnauthenticated.Error(), "unauthenticated")
}

// offeredSubprotocols returns the subprotocols the client offered.
func offeredSubprotocols(header http.Header) map[string]bool {
	protocols := make(map[string]bool)

	for _, value := range header.Values("Sec-WebSocket-Protocol") {
		for protocol := range strings.SplitSeq(value, ",") {
			if protocol = strings.TrimSpace(protocol); protocol != "" {
				protocols[protocol] = true
			}
		}
	}

	return protocols
}

// bearerToken returns the request's token: from exactly one bearer
// subprotocol, or from the Authorization header, but not both.
func bearerToken(header http.Header, protocols map[string]bool) (string, bool) {
	var tokens []string

	for protocol := range protocols {
		if token, ok := strings.CutPrefix(protocol, BearerSubprotocolPrefix); ok {
			tokens = append(tokens, token)
		}
	}

	if authorization := header.Values("Authorization"); len(authorization) > 0 {
		token, ok := auth.BearerToken(authorization[0])
		if !ok || len(authorization) > 1 {
			return "", false
		}

		tokens = append(tokens, token)
	}

	if len(tokens) != 1 || tokens[0] == "" {
		return "", false
	}

	return tokens[0], true
}

// run serves the connection until it ends: it reads client frames here and
// writes and pings on other goroutines.
func (conn *connection) run() {
	limits := conn.hub.limits

	var workers sync.WaitGroup

	workers.Go(conn.writeLoop)
	workers.Go(conn.pingLoop)

	if expiry := conn.user.TokenExpiry; !expiry.IsZero() {
		timer := time.AfterFunc(time.Until(expiry), func() { conn.close(closeExpired) })
		defer timer.Stop()
	}

	for {
		messageType, data, err := conn.ws.Read(conn.ctx)
		if err != nil {
			if errors.Is(err, websocket.ErrMessageTooBig) {
				conn.setEndReason(reasonFrameTooLarge)
			}

			conn.setEndReason(reasonClient)

			break
		}

		if conn.isClosing() {
			// Discard frames until the close handshake completes.
			continue
		}

		if !conn.limiter.allow(time.Now()) {
			conn.close(closeRateLimit)

			continue
		}

		if messageType != websocket.MessageBinary {
			conn.close(closeTextFrame)

			continue
		}

		var frame vaultsyncv1.ClientFrame
		if err := (proto.UnmarshalOptions{RecursionLimit: 8}).Unmarshal(data, &frame); err != nil {
			conn.close(closeMalformed)

			continue
		}

		conn.handle(&frame, limits)
	}

	conn.cancel()
	_ = conn.ws.CloseNow()

	workers.Wait()
}

func (conn *connection) handle(frame *vaultsyncv1.ClientFrame, limits Limits) {
	requestID := frame.GetRequestId()

	switch payload := frame.GetFrame().(type) {
	case *vaultsyncv1.ClientFrame_Subscribe:
		conn.subscribe(requestID, payload.Subscribe.GetVaultId(), limits)
	case *vaultsyncv1.ClientFrame_Unsubscribe:
		vaultID, err := authz.ParseID(payload.Unsubscribe.GetVaultId())
		if err != nil {
			conn.enqueue(errorFrame(requestID, vaultsyncv1.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "vault_id: "+err.Error(), ""))

			return
		}

		conn.hub.unsubscribe(conn, vaultID)
	default:
		// Frames this server does not know are ignored (realtime.proto).
	}
}

func (conn *connection) subscribe(requestID uint64, rawVaultID string, limits Limits) {
	hub := conn.hub

	vaultID, err := authz.ParseID(rawVaultID)
	if err != nil {
		conn.enqueue(errorFrame(requestID, vaultsyncv1.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "vault_id: "+err.Error(), ""))

		return
	}

	existed, err := hub.beginSubscribe(conn, vaultID)
	if err != nil {
		conn.enqueue(errorFrame(requestID, vaultsyncv1.ErrorCode_ERROR_CODE_RESOURCE_EXHAUSTED,
			"at most "+strconv.Itoa(limits.MaxSubscriptions)+" subscriptions per connection", vaultID.String()))

		return
	}

	queryCtx, cancel := context.WithTimeout(conn.ctx, queryTimeout)
	role, headSeq, err := hub.options.Store.MemberHeadSeq(queryCtx, vaultID, conn.user.ID)

	cancel()

	switch {
	case errors.Is(err, store.ErrVaultNotFound):
		// Non-members and vaults that do not exist get the same frame.
		hub.unsubscribe(conn, vaultID)
		conn.enqueue(notFoundFrame(requestID, vaultID))

		return
	case err != nil:
		if !existed {
			hub.unsubscribe(conn, vaultID)
		}

		if conn.ctx.Err() == nil {
			hub.logger.ErrorContext(conn.ctx, "cannot resolve vault role for a realtime subscription", "error", err)
		}

		conn.enqueue(errorFrame(requestID, vaultsyncv1.ErrorCode_ERROR_CODE_UNAVAILABLE, "cannot subscribe right now; retry later", vaultID.String()))

		return
	case role != store.RoleOwner && role != store.RoleEditor && role != store.RoleViewer:
		hub.unsubscribe(conn, vaultID)
		hub.logger.ErrorContext(conn.ctx, "unknown vault role", "role", string(role))
		conn.enqueue(errorFrame(requestID, vaultsyncv1.ErrorCode_ERROR_CODE_PERMISSION_DENIED, "permission denied", vaultID.String()))

		return
	}

	pendingSeq, ok := hub.confirmSubscribe(conn, vaultID)
	if !ok {
		// Unsubscribed meanwhile (a delivery found the user removed).
		conn.enqueue(notFoundFrame(requestID, vaultID))

		return
	}

	conn.enqueue(&vaultsyncv1.ServerFrame{
		RequestId: requestID,
		Frame: &vaultsyncv1.ServerFrame_Subscribed{Subscribed: &vaultsyncv1.Subscribed{
			VaultId: vaultID.String(),
			HeadSeq: uint64(max(headSeq, pendingSeq)), //nolint:gosec // head_seq is never negative.
		}},
	})
}

// enqueue queues frame for the writer. A client whose queue is full is not
// keeping up and is disconnected, so its queue never grows beyond the limit.
func (conn *connection) enqueue(frame *vaultsyncv1.ServerFrame) {
	select {
	case conn.send <- frame:
	default:
		conn.abort(reasonSlowClient)
	}
}

func (conn *connection) writeLoop() {
	for {
		select {
		case <-conn.ctx.Done():
			return
		case frame := <-conn.send:
			if !conn.write(frame) {
				conn.abort(reasonWriteFailed)

				return
			}
		case <-conn.closing:
			request := conn.closeWith
			if request.errCode != vaultsyncv1.ErrorCode_ERROR_CODE_UNSPECIFIED {
				frame := errorFrame(0, request.errCode, request.message, "")
				frame.GetError().Fatal = true

				conn.write(frame)
			}

			// Waits (bounded) for the client's close frame; the read
			// loop then ends.
			_ = conn.ws.Close(request.code, request.text)

			return
		}
	}
}

func (conn *connection) write(frame *vaultsyncv1.ServerFrame) bool {
	data, err := proto.Marshal(frame)
	if err != nil {
		return false
	}

	ctx, cancel := context.WithTimeout(conn.ctx, conn.hub.limits.WriteTimeout)
	defer cancel()

	return conn.ws.Write(ctx, websocket.MessageBinary, data) == nil
}

func (conn *connection) pingLoop() {
	ticker := time.NewTicker(conn.hub.limits.PingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-conn.ctx.Done():
			return
		case <-conn.closing:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(conn.ctx, conn.hub.limits.WriteTimeout)
			err := conn.ws.Ping(ctx)

			cancel()

			if err != nil && conn.ctx.Err() == nil {
				conn.abort(reasonPingTimeout)

				return
			}
		}
	}
}

// close requests a graceful close: the writer sends request's error frame
// (if any) and a close frame. Only the first close or abort takes effect.
func (conn *connection) close(request closeRequest) {
	conn.endOnce.Do(func() {
		conn.closeWith = request
		conn.endReason = request.reason
		close(conn.closing)
	})
}

func (conn *connection) isClosing() bool {
	select {
	case <-conn.closing:
		return true
	default:
		return false
	}
}

// abort closes the connection at once, without a close handshake.
func (conn *connection) abort(reason string) {
	conn.setEndReason(reason)
	conn.cancel()
	_ = conn.ws.CloseNow()
}

func (conn *connection) setEndReason(reason string) {
	conn.endOnce.Do(func() { conn.endReason = reason })
}

func notFoundFrame(requestID uint64, vaultID uuid.UUID) *vaultsyncv1.ServerFrame {
	return errorFrame(requestID, vaultsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND, authz.ErrVaultNotFound.Error(), vaultID.String())
}

func vaultChangedFrame(vaultID uuid.UUID, seq int64) *vaultsyncv1.ServerFrame {
	return &vaultsyncv1.ServerFrame{Frame: &vaultsyncv1.ServerFrame_VaultChanged{VaultChanged: &vaultsyncv1.VaultChanged{
		VaultId: vaultID.String(),
		Seq:     uint64(seq), //nolint:gosec // seqs are never negative.
	}}}
}

func errorFrame(requestID uint64, code vaultsyncv1.ErrorCode, message, vaultID string) *vaultsyncv1.ServerFrame {
	return &vaultsyncv1.ServerFrame{
		RequestId: requestID,
		Frame: &vaultsyncv1.ServerFrame_Error{Error: &vaultsyncv1.ErrorFrame{
			Code: code, Message: message, VaultId: vaultID,
		}},
	}
}
