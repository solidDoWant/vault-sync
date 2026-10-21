// The `apply` intent (docs/design/engine-path-ownership.md §4.4, PO-8) and
// its recovery (engine.ts, recoverApply), #756 item 1. A crash after the
// apply's disk write leaves the intent open; the restart finishes the apply
// from the disk alone when the disk shows the revision, before the pull asks
// the server for anything, and drops the intent when the disk shows the
// user's change instead, so the pull applies the revision again.

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import type {
  DeferredRevision,
  DocumentState,
  JournalChanges,
  NewIntent,
} from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import { InMemoryServer } from "./memory-server";
import {
  Crash,
  CrashingVault,
  CrashPoints,
  harness,
  type Harness,
} from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);

/** A journal that takes no write once the app is dead: the crash kills the app, so no error handler of the engine records anything after it. */
class MortalJournal extends InMemoryJournal {
  dead = false;
  private alive(): void {
    if (this.dead) throw new Crash("the app is dead");
  }
  override transact(changes: JournalChanges): Promise<void> {
    this.alive();
    return super.transact(changes);
  }
  override putIntent(intent: NewIntent): Promise<number> {
    this.alive();
    return super.putIntent(intent);
  }
  override removeIntent(id: number): Promise<void> {
    this.alive();
    return super.removeIntent(id);
  }
  override putDocument(state: DocumentState): Promise<void> {
    this.alive();
    return super.putDocument(state);
  }
  override putDeferred(deferred: DeferredRevision): Promise<void> {
    this.alive();
    return super.putDeferred(deferred);
  }
  override removeDeferred(documentId: string): Promise<void> {
    this.alive();
    return super.removeDeferred(documentId);
  }
  override setCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    this.alive();
    return super.setCursor(seq, anchor);
  }
}

/** Crash points that kill the app: the journal takes no write after the crash. */
class KillingPoints extends CrashPoints {
  constructor(private readonly journal: MortalJournal) {
    super();
  }
  override async durable<T>(change: () => Promise<T>): Promise<T> {
    try {
      return await super.durable(change);
    } catch (error) {
      if (error instanceof Crash) this.journal.dead = true;
      throw error;
    }
  }
}

/** A device whose vault mutations are crash points; its journal's are not, so crash point 1 is the first disk change. */
function device(): { h: Harness; points: CrashPoints } {
  const journal = new MortalJournal();
  const points = new KillingPoints(journal);
  const h = harness({
    server: new InMemoryServer(),
    journal,
    wrapVault: (inner) => new CrashingVault(inner, points),
  });
  const restart = h.restart.bind(h);
  h.restart = () => {
    journal.dead = false;
    return restart();
  };
  return { h, points };
}

/** Pulls, crashing right after the pull's first disk change, and restarts the engine over the same vault and journal. */
async function pullCrashingAfterDiskWrite(
  h: Harness,
  points: CrashPoints,
): Promise<void> {
  points.count = 0;
  points.crashAfter = 1;
  await expect(h.engine.pull()).rejects.toBeInstanceOf(Crash);
  points.crashAfter = 0;
  expect(await h.journal.listIntents()).toMatchObject([
    { kind: "apply", documentId: "A" },
  ]);
  h.restart();
}

/** Makes every call to the server fail, as if it were unreachable. */
function unreachable(h: Harness): void {
  h.server.interceptor = () => {
    throw new Error("server unreachable");
  };
}

describe("recovery of an apply intent a crash left open", () => {
  it("finishes an edit's apply from the disk: base and binding move to the revision without the server", async () => {
    const { h, points } = device();
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();
    const edit = h.server.commit({
      documentId: "A",
      path: "a.md",
      content: "a2",
    });
    await pullCrashingAfterDiskWrite(h, points);
    expect(new TextDecoder().decode(await h.vault.read("a.md"))).toBe("a2");

    unreachable(h);
    await expect(h.engine.pull()).rejects.toThrow();

    expect(await h.journal.listIntents()).toEqual([]);
    expect(await h.journal.getDocument("A")).toMatchObject({
      revisionId: edit.id,
      baseHash: sha256Hex(bytes("a2")),
      deleted: false,
      binding: { spelling: "a.md" },
    });
    // The finished apply is no local change: nothing to push.
    h.server.interceptor = undefined;
    await h.engine.push();
    expect(await h.journal.listPending()).toEqual([]);
    expect(h.server.history("A")).toHaveLength(2);
  });

  it("finishes a tombstone's apply from the disk: the document is deleted and unbound without the server", async () => {
    const { h, points } = device();
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();
    const tombstone = h.server.commit({
      documentId: "A",
      path: "a.md",
      deleted: true,
    });
    await pullCrashingAfterDiskWrite(h, points);
    expect(await h.vault.list()).toEqual([]);

    unreachable(h);
    await expect(h.engine.pull()).rejects.toThrow();

    expect(await h.journal.listIntents()).toEqual([]);
    expect(await h.journal.getDocument("A")).toMatchObject({
      revisionId: tombstone.id,
      deleted: true,
      binding: null,
    });
    // The finished delete is no local change: nothing to push.
    h.server.interceptor = undefined;
    await h.engine.push();
    expect(await h.journal.listPending()).toEqual([]);
    expect(h.server.history("A")).toHaveLength(2);
  });

  it("drops the intent when the disk shows the user's change, and the pull applies the revision again, merging it", async () => {
    const { h, points } = device();
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();
    const base = await h.journal.getDocument("A");
    const edit = h.server.commit({
      documentId: "A",
      path: "a.md",
      content: "a2",
    });
    await pullCrashingAfterDiskWrite(h, points);
    // While the app is closed, the user edits the file the apply wrote.
    await h.vault.write("a.md", bytes("mine"));
    h.restart();

    await h.engine.pull();

    expect(await h.journal.listIntents()).toEqual([]);
    // The revision went to the merge path against the document's old base, with the user's content as the local side.
    expect(h.merges).toHaveLength(1);
    expect(
      new TextDecoder().decode(h.merges[0]?.local.content ?? new Uint8Array()),
    ).toBe("mine");
    expect(h.merges[0]?.remote.revisionId).toBe(edit.id);
    expect((await h.journal.getDocument("A"))?.revisionId).toBe(
      base?.revisionId,
    );
    expect(await h.journal.listDeferred()).toMatchObject([
      { revision: { revisionId: edit.id } },
    ]);
    expect(new TextDecoder().decode(await h.vault.read("a.md"))).toBe("mine");
  });

  it("finishes a tombstone's apply for a document with no file bound: nothing of it is on the disk to undo", async () => {
    const { h, points } = device();
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();
    const tombstone = h.server.commit({
      documentId: "A",
      path: "a.md",
      deleted: true,
    });
    await pullCrashingAfterDiskWrite(h, points);
    // The document's row holds no binding when the restart recovers the intent.
    const state = await h.journal.getDocument("A");
    if (state === undefined) throw new Error("A not synced");
    await h.journal.putDocument({ ...state, binding: null });

    unreachable(h);
    await expect(h.engine.pull()).rejects.toThrow();

    expect(await h.journal.listIntents()).toEqual([]);
    expect(await h.journal.getDocument("A")).toMatchObject({
      revisionId: tombstone.id,
      deleted: true,
      binding: null,
    });
  });
});
