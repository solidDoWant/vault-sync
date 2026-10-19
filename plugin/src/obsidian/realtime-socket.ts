import { realtimeUrl, type RealtimeConnector } from "../core/realtime/client";

// The realtime channel over the platform's WebSocket (Electron's on desktop,
// the WebView's on mobile). Obsidian's requestUrl has no WebSocket
// counterpart, so this is the browser API, which cannot set an Authorization
// header: the token travels in the bearer subprotocol (SPEC.md §6.4).

/** The subset of the WebSocket API used here, so tests can pass a fake. */
export interface WebSocketLike {
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

const browserWebSocket: WebSocketFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike;

/**
 * A connector to `serverUrl`'s realtime endpoint. The URL is the server's
 * alone; the token is only ever one of the offered subprotocols.
 */
export function webSocketConnector(serverUrl: string, create: WebSocketFactory = browserWebSocket): RealtimeConnector {
  const url = realtimeUrl(serverUrl);
  return (protocols, handlers) => {
    const socket = create(url, [...protocols]);
    socket.binaryType = "arraybuffer";
    let closed = false;
    socket.onopen = () => {
      handlers.open();
    };
    socket.onmessage = (event) => {
      // The server sends binary frames only; anything else is ignored.
      if (event.data instanceof ArrayBuffer) handlers.message(new Uint8Array(event.data));
    };
    socket.onclose = (event) => {
      if (closed) return;
      closed = true;
      handlers.close(event.code);
    };
    // An error is always followed by a close event, which reports it. The
    // event carries nothing useful (and is never logged: it may name the
    // request).
    socket.onerror = () => undefined;
    return {
      send: (data) => {
        try {
          socket.send(data);
        } catch {
          // Closing already; its close event follows.
        }
      },
      close: () => {
        socket.close();
      },
    };
  };
}
