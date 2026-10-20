import { Code, ConnectError } from "@connectrpc/connect";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import { InMemoryServer } from "./memory-server";
import { harness } from "./testing";

// Upload sessions abandoned by interrupted uploads must not fill the vault's
// session limit and block every later upload (#370, SPEC.md §6.2).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

const minute = 60_000;
/** The server's defaults: VAULT_SYNC_BLOB_MAX_UPLOADS_PER_VAULT and VAULT_SYNC_BLOB_UPLOAD_RECLAIM_IDLE. */
const maxUploads = 32;
const reclaimIdleMs = 10 * minute;

/** A server with the real session limit and idle reclaim, on a clock the test moves. */
function limitedServer() {
  let clock = Date.UTC(2026, 9, 20);
  const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5, maxUploads, uploadReclaimIdleMs: reclaimIdleMs, now: () => new Date(clock) });
  return {
    server,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** The engine's RESOURCE_EXHAUSTED backoff, with no wait, so a refusal shows as a failed push instead of a stall. */
const noBackoff = { rateLimitBackoff: { initialMs: 0, maxMs: 0 } };

const contentOf = (server: InMemoryServer, path: string) => server.liveFiles().get(path);

describe("abandoned upload sessions", () => {
  it("still uploads after more interrupted rounds of an edited note than the vault's session limit", async () => {
    const { server, advance } = limitedServer();
    const h = harness({ server, ...noBackoff });
    await h.engine.pull();
    let failing = false;
    h.server.interceptor = (method) => {
      if (failing && method === "PutBlobChunk") throw new ConnectError("unavailable", Code.Unavailable);
    };
    // One interrupted round a minute: 40 rounds in 40 minutes, far within
    // the 24 h upload TTL, each abandoning a session for its draft.
    for (let round = 0; round < maxUploads + 8; round++) {
      await h.vault.write("note.md", bytes(`draft ${String(round)}`));
      failing = true;
      await h.engine.push().catch(() => undefined);
      failing = false;
      advance(minute);
    }
    await h.vault.write("note.md", bytes("final"));
    await h.engine.push();
    expect(contentOf(server, "note.md")).toBe("final");
    expect(server.openUploads()).toBeLessThanOrEqual(maxUploads);
  });

  it("lets another device upload once a device has filled the session limit and gone idle", async () => {
    const { server, advance } = limitedServer();
    const flaky = harness({ server, idPrefix: "a", deviceName: "phone", ...noBackoff });
    const other = harness({ server, idPrefix: "b", deviceName: "laptop", ...noBackoff });
    await flaky.engine.pull();
    await other.engine.pull();
    server.interceptor = (method) => {
      if (method === "PutBlobChunk") throw new ConnectError("unavailable", Code.Unavailable);
    };
    for (let round = 0; round < maxUploads; round++) {
      await flaky.vault.write("note.md", bytes(`draft ${String(round)}`));
      await flaky.engine.push().catch(() => undefined);
    }
    server.interceptor = undefined;
    expect(server.openUploads()).toBe(maxUploads);
    advance(reclaimIdleMs + minute);
    await other.vault.write("other.md", bytes("from the laptop"));
    await other.engine.push();
    expect(contentOf(server, "other.md")).toBe("from the laptop");
  });

  it("opens no upload session for content that changed before its upload began", async () => {
    const h = harness();
    await h.engine.pull();
    let interrupt = true;
    h.server.interceptor = (method) => {
      if (interrupt && method === "BeginBlob") throw new ConnectError("unavailable", Code.Unavailable);
    };
    await h.vault.write("note.md", bytes("stale"));
    await h.engine.push().catch(() => undefined);
    interrupt = false;
    const begun: string[] = [];
    h.server.interceptor = (method, request) => {
      if (method === "BeginBlob") begun.push(bytesToHex((request as { blobId: Uint8Array }).blobId));
    };
    await h.vault.write("note.md", bytes("fresh"));
    await h.engine.push();
    expect(begun).not.toContain(sha256Hex(bytes("stale")));
    expect(h.server.openUploads()).toBe(0);
    expect(contentOf(h.server, "note.md")).toBe("fresh");
  });

  it("restarts an upload whose session the server reclaimed with a fresh session", async () => {
    const { server, advance } = limitedServer();
    const h = harness({ server, ...noBackoff });
    await h.engine.pull();
    const content = bytes("x".repeat(server.maxChunkBytes + 1));
    let chunks = 0;
    let reclaimed = false;
    server.interceptor = (method) => {
      // Between the first and the second chunk, the session goes idle and
      // a BeginBlob in the full vault reclaims it.
      if (method === "PutBlobChunk" && ++chunks === 2) {
        advance(reclaimIdleMs + minute);
        reclaimed = server.reclaimIdleUploads() === 1;
      }
    };
    await h.vault.write("big.md", content);
    await h.engine.push();
    expect(reclaimed).toBe(true);
    expect(contentOf(server, "big.md")).toBe("x".repeat(server.maxChunkBytes + 1));
    expect(server.openUploads()).toBe(0);
  });
});
