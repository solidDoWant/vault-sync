import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import type { FileStat, VaultAdapter, VaultListener, WritePrecondition, DeletePrecondition } from "../vault/adapter";
import { harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);

/** A vault that runs a change once, right before the next read of a path. */
class ReadRaceVault implements VaultAdapter {
  private armed: { path: string; change: () => Promise<void> } | undefined;
  constructor(readonly inner: VaultAdapter) {}
  beforeNextRead(path: string, change: () => Promise<void>): void {
    this.armed = { path, change };
  }
  list(): Promise<string[]> {
    return this.inner.list();
  }
  async read(path: string): Promise<Uint8Array> {
    const armed = this.armed;
    if (armed !== undefined && armed.path === path) {
      this.armed = undefined;
      await armed.change();
    }
    return this.inner.read(path);
  }
  stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(path);
  }
  watch(listener: VaultListener): () => void {
    return this.inner.watch(listener);
  }
  write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void> {
    return this.inner.write(path, data, precondition);
  }
  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }
  delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    return this.inner.delete(path, precondition);
  }
}

// supersedeCreates (engine.ts) drops the outbox of a create bound to a file
// a pull adopts or merges into; never a known document's, whose pending
// operations may carry an edit the server has not seen (SPEC.md §2
// principle 1, #671 item 7). Rule W moves a known holder's file away first,
// so a known document is bound there only when the user moves its file onto
// the path while the pull downloads the revision.

describe("a known document bound to the file a pull adopts", () => {
  it("keeps the known document's pending operations (only a create may be superseded)", async () => {
    let race: ReadRaceVault | undefined;
    const h = harness({ merge: "default", wrapVault: (vault) => (race = new ReadRaceVault(vault)) });
    h.server.commit({ documentId: "K", path: "k.md", content: "k1" });
    await h.engine.pull();
    await h.vault.write("k.md", bytes("same"));
    await h.engine.settled();
    const state = await h.journal.getDocument("K");
    if (state === undefined || race === undefined) throw new Error("K not synced");
    h.engine.dispose();
    // An interrupted push left K's edit in the outbox.
    await h.journal.addPending({ revisionId: "edit", documentId: "K", baseRevisionId: state.revisionId, path: "k.md", contentHash: sha256Hex(bytes("same")), size: 4n, kind: state.kind, deleted: false });
    h.restart();
    await h.engine.settled();
    h.server.commit({ documentId: "R", path: "p.md", content: "same" });
    // While the pull downloads R, the user moves K's file onto R's path.
    race.beforeNextRead("p.md", () => h.vault.rename("k.md", "p.md"));

    await h.engine.pull();
    await h.engine.settled();

    // Only a create the server has not acknowledged may be superseded
    // (design §4.5 step 3): the pull drops none of K's operations.
    expect(await h.journal.listPending()).toEqual([expect.objectContaining({ revisionId: "edit", documentId: "K" })]);
    await h.engine.push();
    await h.engine.settled();
    // Nothing is lost: the edit's content is on the server.
    expect(h.server.liveFiles().get("p.md")).toBe("same");
  });
});
