import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import type { FileStat, VaultAdapter, VaultListener, WritePrecondition, DeletePrecondition } from "../vault/adapter";
import { harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);

/** A vault that runs each armed change once, in order, right before a read of its path. */
class ReadRaceVault implements VaultAdapter {
  private readonly armed: { path: string; change: () => Promise<void> }[] = [];
  constructor(readonly inner: VaultAdapter) {}
  beforeNextRead(path: string, change: () => Promise<void>): void {
    this.armed.push({ path, change });
  }
  list(): Promise<string[]> {
    return this.inner.list();
  }
  async read(path: string): Promise<Uint8Array> {
    const armed = this.armed[0];
    if (armed !== undefined && armed.path === path) {
      this.armed.shift();
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

// A pull adopts a file at a revision's path only if it is untracked and
// holds the revision's bytes (design §4.5 step 3, INV-3). A known document's
// file is bound to it, also when the user moves it onto the path while the
// pull downloads the revision: rule W(a) (PO-4) moves it on to a copy name
// under its own id, its outbox commits the rename and its edit as its own,
// and the revision materializes at its path (#671 item 7, #757).

describe("a known document whose file the user moves onto a revision's path during the pull", () => {
  it("keeps its file and pending edit under its own id, displaced by rule W(a); the revision materializes at its path", async () => {
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

    // K stays bound to its file, which rule W moved on to a copy name.
    const moved = await h.journal.getDocument("K");
    const spelling = moved?.binding?.spelling ?? "";
    expect(spelling).toMatch(/^p \(conflict .*\)\.md$/);
    expect((await h.journal.getDocument("R"))?.binding?.spelling).toBe("p.md");

    await h.engine.push();
    await h.engine.settled();

    // K's rename and edit are committed as K's; R is at its path.
    expect(h.server.liveDocuments()).toEqual(new Map([["p.md", "R"], [spelling, "K"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["p.md", "same"], [spelling, "same"]]));
    expect(await h.journal.listPending()).toEqual([]);
    expect([...(await h.vault.list())].sort()).toEqual(["p.md", spelling].sort());
  });

  it("defers the revision after three files the user keeps moving onto its path, loses none, and applies it on a later pull", async () => {
    let race: ReadRaceVault | undefined;
    const h = harness({ merge: "default", wrapVault: (vault) => (race = new ReadRaceVault(vault)) });
    for (const name of ["k1", "k2", "k3"]) h.server.commit({ documentId: name.toUpperCase(), path: `${name}.md`, content: "same" });
    await h.engine.pull();
    await h.engine.settled();
    if (race === undefined) throw new Error("no vault");
    h.server.commit({ documentId: "R", path: "p.md", content: "same" });
    // Each look at p.md finds another known document's file moved there.
    const moveOnto = (name: string): (() => Promise<void>) => async () => {
      // The vault moves nothing onto a file: the move waits for the next look once p.md is free.
      if ((await h.vault.stat("p.md")) === null) await h.vault.rename(`${name}.md`, "p.md");
      else race?.beforeNextRead("p.md", moveOnto(name));
    };
    for (const name of ["k1", "k2", "k3"]) race.beforeNextRead("p.md", moveOnto(name));

    await h.engine.pull();
    await h.engine.settled();

    // The revision waits, listed; no known document lost its file or was taken for R.
    expect((await h.journal.getDeferred("R"))?.reason).toBe("path-conflict");
    for (const id of ["K1", "K2", "K3"]) {
      const spelling = (await h.journal.getDocument(id))?.binding?.spelling;
      expect(spelling, id).toEqual(expect.any(String));
      expect(new TextDecoder().decode(await h.vault.read(spelling ?? "")), id).toBe("same");
    }

    // A later pull applies R once the user stops; the pushes commit every move under its own id.
    await h.engine.push();
    await h.engine.settled();
    await h.engine.pull();
    await h.engine.push();
    await h.engine.settled();
    expect(h.server.liveDocuments().get("p.md")).toBe("R");
    expect(new Set(h.server.liveDocuments().values())).toEqual(new Set(["R", "K1", "K2", "K3"]));
    expect(await h.journal.getDeferred("R")).toBeUndefined();
    expect(await h.journal.listPending()).toEqual([]);
  });
});
