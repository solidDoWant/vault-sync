import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { InMemoryServer } from "../engine/memory-server";
import { createProtocolClient } from "../protocol/client";
import { InMemoryVault } from "../vault/memory";
import { SyncEngine } from "./engine";
import { IndexedDbSyncJournal } from "./indexeddb";
import { MemorySyncJournal, type DocEntry, type PendingOp, type SyncJournal } from "./journal";
import { Device } from "./testing";

const doc: DocEntry = {
  documentId: "doc-1",
  path: "a.md",
  kind: "text",
  baseRevId: "rev-1",
  baseHash: "ab",
  baseSize: 2,
};

function op(order: number, opId = `op-${String(order)}`): PendingOp {
  return {
    opId,
    order,
    documentId: "doc-1",
    kind: "edit",
    path: "a.md",
    docKind: "text",
    revisionId: `rev-${opId}`,
    contentHash: "cd",
    contentSize: 2,
    sent: false,
  };
}

const journals: [string, () => Promise<SyncJournal>][] = [
  ["in memory", () => Promise.resolve(new MemorySyncJournal())],
  ["on IndexedDB", () => IndexedDbSyncJournal.open(new IDBFactory(), "journal")],
];

describe.each(journals)("the journal %s", (_name, open) => {
  it("starts empty at seq 0", async () => {
    const state = await (await open()).load();
    expect(state.cursor.seq).toBe(0n);
    expect(state.docs.size).toBe(0);
    expect(state.pending).toEqual([]);
    expect(state.conflicts.size).toBe(0);
  });

  it("keeps the cursor, documents, pending operations in order and conflicts", async () => {
    const journal = await open();
    await journal.commit({
      cursor: { seq: 7n, anchor: new Uint8Array([1, 2]) },
      putDocs: [doc],
      putPending: [op(3), op(1)],
      putConflicts: [{ path: "c.md", documentId: "doc-1", createdAt: 5 }],
    });
    await journal.commit({
      putPending: [{ ...op(1), sent: true }, op(2)],
      deletePending: ["op-3"],
    });
    const state = await journal.load();
    expect(state.cursor).toEqual({ seq: 7n, anchor: new Uint8Array([1, 2]) });
    expect(state.docs.get("doc-1")).toEqual(doc);
    expect(state.pending.map((pending) => [pending.opId, pending.sent])).toEqual([
      ["op-1", true],
      ["op-2", false],
    ]);
    expect([...state.conflicts.keys()]).toEqual(["c.md"]);
    await journal.commit({ deleteDocs: ["doc-1"], deleteConflicts: ["c.md"] });
    const after = await journal.load();
    expect(after.docs.size).toBe(0);
    expect(after.conflicts.size).toBe(0);
  });

  it("returns copies: changing a loaded state changes nothing stored", async () => {
    const journal = await open();
    await journal.commit({ putDocs: [doc] });
    const state = await journal.load();
    state.docs.clear();
    expect((await journal.load()).docs.size).toBe(1);
  });
});

describe("an engine on the IndexedDB journal", () => {
  it("resumes after a restart from what the journal recorded", async () => {
    const server = new InMemoryServer();
    const factory = new IDBFactory();
    const vault = new InMemoryVault();
    const engine = (journal: SyncJournal) =>
      new SyncEngine({
        api: createProtocolClient({ transport: server.transport }),
        vaultId: server.vaultId,
        deviceId: "device-b",
        vault,
        journal,
      });
    const a = new Device(server, "device-a");
    await a.write("a.md", "one");
    await a.sync();
    const first = await IndexedDbSyncJournal.open(factory, "vault");
    await engine(first).sync();
    first.close();
    await a.write("a.md", "two");
    await a.sync();
    const second = await IndexedDbSyncJournal.open(factory, "vault");
    await engine(second).sync();
    expect(new TextDecoder().decode(await vault.read("a.md"))).toBe("two");
    expect(server.history(server.liveDocuments().get("a.md") ?? "")).toHaveLength(2);
    expect((await second.load()).cursor.seq).toBe(2n);
  });
});
