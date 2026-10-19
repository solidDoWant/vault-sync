import { describe, expect, it } from "vitest";

import type { DeletePrecondition, FileStat, VaultAdapter, VaultEvent, VaultListener, WritePrecondition } from "../vault/adapter";
import { harness, InterleavingVault, type Harness } from "./testing";

// The engine suppresses the vault events its own changes cause (SPEC.md §8).
// An expectation it registers must never outlive its change: left behind, it
// would swallow a later user change at the same path.

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

/** A VaultAdapter whose watcher loses the next event matching `dropNext`, as a platform watcher may. */
class DroppingVault implements VaultAdapter {
  dropNext: ((event: VaultEvent) => boolean) | undefined;
  private readonly listeners = new Set<VaultListener>();

  constructor(readonly inner: VaultAdapter) {
    inner.watch((event) => {
      if (this.dropNext?.(event) === true) {
        this.dropNext = undefined;
        return;
      }
      for (const listener of this.listeners) listener(event);
    });
  }

  list(): Promise<string[]> {
    return this.inner.list();
  }
  read(path: string): Promise<Uint8Array> {
    return this.inner.read(path);
  }
  stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(path);
  }
  watch(listener: VaultListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

function wrapped<T extends VaultAdapter>(wrap: (inner: VaultAdapter) => T): { h: Harness; vault: T } {
  let vault: T | undefined;
  const h = harness({
    wrapVault: (inner) => {
      vault = wrap(inner);
      return vault;
    },
  });
  if (vault === undefined) throw new Error("the harness did not wrap the vault");
  return { h, vault };
}

describe("SyncEngine echo suppression", () => {
  it("reports a user delete after the event of an engine delete at that path was lost", async () => {
    const { h, vault } = wrapped((inner) => new DroppingVault(inner));
    h.server.commit({ documentId: "d", path: "d.md", content: "d1" });
    await h.engine.pull();
    vault.dropNext = (event) => event.type === "delete" && event.path === "d.md";
    h.server.commit({ documentId: "d", path: "d.md", deleted: true });
    await h.engine.pull();
    h.server.commit({ documentId: "d", path: "d.md", content: "d2" });
    await h.engine.pull();
    await h.engine.settled();
    expect(vault.dropNext).toBeUndefined();
    expect(h.localChanges).toEqual([]);

    await h.vault.delete("d.md");
    await h.engine.settled();

    expect(h.localChanges).toEqual([{ type: "delete", path: "d.md" }]);
  });

  it("reports a user rename after the event of an engine rename to that path was lost", async () => {
    const { h, vault } = wrapped((inner) => new DroppingVault(inner));
    h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
    await h.engine.pull();
    vault.dropNext = (event) => event.type === "rename" && event.path === "b.md";
    h.server.commit({ documentId: "a", path: "b.md" });
    await h.engine.pull();
    h.server.commit({ documentId: "a", path: "b.md", content: "a2" });
    await h.engine.pull();
    h.server.commit({ documentId: "a", path: "a.md" });
    await h.engine.pull();
    await h.engine.settled();
    expect(vault.dropNext).toBeUndefined();
    expect(h.localChanges).toEqual([]);

    await h.vault.rename("a.md", "b.md");
    await h.engine.settled();

    expect(h.localChanges).toEqual([{ type: "rename", path: "b.md", oldPath: "a.md" }]);
  });

  it("drops the expectation of an engine change that failed, so a later user change is reported", async () => {
    const { h, vault } = wrapped((inner) => new InterleavingVault(inner));
    h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
    await h.engine.pull();
    // A save lands between the engine's check and its delete, so the delete fails.
    vault.beforeNextChange("a.md", () => h.vault.write("a.md", bytes("local save")));
    h.server.commit({ documentId: "a", path: "a.md", deleted: true });
    await h.engine.pull();
    await h.engine.settled();
    expect(vault.pending).toBe(false);
    expect(h.localChanges).toEqual([{ type: "modify", path: "a.md" }]);

    await h.vault.delete("a.md");
    await h.engine.settled();

    expect(h.localChanges).toEqual([
      { type: "modify", path: "a.md" },
      { type: "delete", path: "a.md" },
    ]);
  });
});
