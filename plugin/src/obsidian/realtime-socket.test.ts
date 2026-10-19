import { describe, expect, it } from "vitest";

import type { RealtimeSocketHandlers } from "../core/realtime/client";
import { webSocketConnector, type WebSocketLike } from "./realtime-socket";

class FakeWebSocket implements WebSocketLike {
  binaryType = "blob";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closeCalls = 0;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
  }
}

function connect(serverUrl = "https://sync.example/") {
  const sockets: FakeWebSocket[] = [];
  const events: string[] = [];
  const handlers: RealtimeSocketHandlers = {
    open: () => events.push("open"),
    message: (data) => events.push(`message ${Array.from(data).join(",")}`),
    close: (code) => events.push(`close ${String(code)}`),
  };
  const socket = webSocketConnector(serverUrl, (url, protocols) => {
    const created = new FakeWebSocket(url, protocols);
    sockets.push(created);
    return created;
  })(["vaultsync.v1", "vaultsync.bearer.secret-token"], handlers);
  const [created] = sockets;
  if (created === undefined) throw new Error("no socket was created");
  return { socket, created, events };
}

describe("webSocketConnector", () => {
  it("opens the server's realtime endpoint with the token only in the offered subprotocols", () => {
    const { created } = connect();

    expect(created.url).toBe("wss://sync.example/v1/realtime");
    expect(created.url).not.toContain("secret-token");
    expect(created.protocols).toEqual(["vaultsync.v1", "vaultsync.bearer.secret-token"]);
    expect(created.binaryType).toBe("arraybuffer");
  });

  it("passes binary messages on as bytes and ignores text", () => {
    const { created, events } = connect();
    created.onopen?.({});
    created.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
    created.onmessage?.({ data: "text" });

    expect(events).toEqual(["open", "message 1,2,3"]);
  });

  it("reports the close code once, after an error too", () => {
    const { created, events } = connect();
    created.onerror?.({});
    created.onclose?.({ code: 1006 });
    created.onclose?.({ code: 1006 });

    expect(events).toEqual(["close 1006"]);
  });

  it("sends and closes through the WebSocket", () => {
    const { socket, created } = connect();
    socket.send(new Uint8Array([9]));
    socket.close();

    expect(created.sent).toEqual([new Uint8Array([9])]);
    expect(created.closeCalls).toBe(1);
  });
});
