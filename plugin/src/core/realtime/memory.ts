import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { ClientFrameSchema, ErrorCode, ServerFrameSchema, type ServerFrame } from "../../gen/vaultsync/v1/realtime_pb";
import { bearerSubprotocolPrefix, closeCodes, realtimeSubprotocol, type RealtimeConnector, type RealtimeSocketHandlers } from "./client";

// An in-process stand-in for the server's realtime endpoint (SPEC.md §6.4),
// for unit tests: no network. It authenticates the bearer subprotocol,
// answers subscribe with subscribed, fans notifications out to subscribers,
// and can expire, drain, drop or refuse connections like the real hub.

export interface InMemoryRealtimeOptions {
  /** Whether a token is valid; the default accepts any non-empty one. */
  authenticate?: (token: string) => boolean;
  /** The vault's head_seq reported in subscribed. */
  headSeq?: (vaultId: string) => bigint;
}

/** One socket a client opened. */
export class InMemoryRealtimeConnection {
  readonly subscriptions = new Set<string>();
  open = false;
  closed = false;
  /** Every frame the server sent on this connection. */
  readonly sent: ServerFrame[] = [];

  constructor(
    /** The subprotocols the client offered. */
    readonly protocols: readonly string[],
    private readonly handlers: RealtimeSocketHandlers,
  ) {}

  /** The offered bearer token, if exactly one was offered. */
  get token(): string | undefined {
    const tokens = this.protocols.filter((protocol) => protocol.startsWith(bearerSubprotocolPrefix));
    return tokens.length === 1 ? tokens[0]?.slice(bearerSubprotocolPrefix.length) : undefined;
  }

  /** Sends a frame to the client. */
  send(frame: ServerFrame): void {
    if (!this.open || this.closed) return;
    this.sent.push(frame);
    this.handlers.message(toBinary(ServerFrameSchema, frame));
  }

  /** Closes the socket from the server's side (or the network's, with 1006). */
  close(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.handlers.close(code);
  }

  /** @internal */
  accept(): void {
    this.open = true;
    this.handlers.open();
  }
}

export class InMemoryRealtimeServer {
  readonly connections: InMemoryRealtimeConnection[] = [];
  /** Set to an HTTP status to refuse every upgrade (the client sees 1006, as a browser does). */
  refuseWith: 429 | 503 | undefined;
  /** Set to hold every subscribe back, unanswered and unregistered, until releaseSubscribes(): a slow subscribe. */
  holdSubscribes = false;
  private readonly held: (() => void)[] = [];
  private readonly authenticate: (token: string) => boolean;
  private readonly headSeq: (vaultId: string) => bigint;

  constructor(options: InMemoryRealtimeOptions = {}) {
    this.authenticate = options.authenticate ?? ((token) => token !== "");
    this.headSeq = options.headSeq ?? (() => 0n);
  }

  /** The connector clients open sockets with. Events are delivered asynchronously, as by a WebSocket. */
  readonly connect: RealtimeConnector = (protocols, handlers) => {
    const connection = new InMemoryRealtimeConnection([...protocols], handlers);
    this.connections.push(connection);
    queueMicrotask(() => {
      if (connection.closed) return;
      const token = connection.token;
      if (this.refuseWith !== undefined || !protocols.includes(realtimeSubprotocol) || token === undefined || !this.authenticate(token)) {
        connection.close(closeCodes.abnormal);
        return;
      }
      connection.accept();
    });
    return {
      send: (data) => {
        queueMicrotask(() => {
          this.receive(connection, data);
        });
      },
      close: () => {
        // The client's own close; a WebSocket reports it too, later.
        queueMicrotask(() => {
          connection.close(closeCodes.normal);
        });
      },
    };
  };

  /** Connections still open. */
  get open(): InMemoryRealtimeConnection[] {
    return this.connections.filter((connection) => connection.open);
  }

  /** How many subscribes are held back. */
  get heldSubscribes(): number {
    return this.held.length;
  }

  /** Handles the held subscribes now, as they would have been on arrival, and stops holding. */
  releaseSubscribes(): void {
    this.holdSubscribes = false;
    for (const subscribe of this.held.splice(0)) subscribe();
  }

  /** Notifies every subscriber of `vaultId` that its head is now `seq`. */
  notify(vaultId: string, seq: bigint): void {
    for (const connection of this.open) {
      if (connection.subscriptions.has(vaultId)) connection.send(create(ServerFrameSchema, { frame: { case: "vaultChanged", value: { vaultId, seq } } }));
    }
  }

  /** The token's expiry: the fatal UNAUTHENTICATED frame, then 1008. */
  expire(connection: InMemoryRealtimeConnection): void {
    connection.send(
      create(ServerFrameSchema, {
        frame: { case: "error", value: { code: ErrorCode.UNAUTHENTICATED, message: "access token expired; reconnect with a fresh token", fatal: true } },
      }),
    );
    connection.close(closeCodes.policyViolation);
  }

  /** Every open socket closed with `code` (1001 for a drain, 1006 for a dropped network). */
  closeAll(code: number): void {
    for (const connection of this.open) connection.close(code);
  }

  private receive(connection: InMemoryRealtimeConnection, data: Uint8Array): void {
    if (!connection.open) return;
    const frame = fromBinary(ClientFrameSchema, data);
    if (frame.frame.case === "subscribe") {
      const { vaultId } = frame.frame.value;
      const subscribe = () => {
        if (!connection.open) return;
        // As the real hub does: registered first, then the head read.
        connection.subscriptions.add(vaultId);
        connection.send(create(ServerFrameSchema, { requestId: frame.requestId, frame: { case: "subscribed", value: { vaultId, headSeq: this.headSeq(vaultId) } } }));
      };
      if (this.holdSubscribes) this.held.push(subscribe);
      else subscribe();
    } else if (frame.frame.case === "unsubscribe") {
      connection.subscriptions.delete(frame.frame.value.vaultId);
    }
  }
}
