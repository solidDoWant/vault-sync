import { describe, expect, it } from "vitest";

import { InMemoryServer } from "../engine/memory-server";
import { createProtocolClient } from "../protocol/client";
import type { DeletePrecondition, FileStat, VaultAdapter, VaultListener, WritePrecondition } from "../vault/adapter";
import { InMemoryVault } from "../vault/memory";
import { SyncEngine } from "./engine";
import { MemorySyncJournal, type JournalChange, type JournalState, type SyncJournal } from "./journal";
import { Device, ManualTimers, settle } from "./testing";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The app was killed. */
class Crash extends Error {
  override readonly name = "Crash";
}

/** Counts the steps of a sync and kills the app at step `crashAt` (none while undefined). */
class Steps {
  crashAt: number | undefined;
  taken = 0;

  step(): void {
    if (this.crashAt === undefined) return;
    if (this.taken++ === this.crashAt) {
      this.crashAt = undefined;
      throw new Crash(`killed at step ${String(this.taken - 1)}`);
    }
  }

  get crashed(): boolean {
    return this.crashAt === undefined;
  }
}

/**
 * A vault on disk whose app can be killed before each change. A write killed
 * midway leaves the first half of the bytes, as a file system write does; a
 * replace (desktop) and a rename are atomic.
 */
class CrashingVault implements VaultAdapter {
  readonly replace?: (from: string, to: string, precondition: WritePrecondition) => Promise<void>;

  constructor(
    readonly disk: InMemoryVault,
    private readonly steps: Steps,
  ) {
    const replace = disk.replace;
    if (replace !== undefined) {
      this.replace = (from, to, precondition) => {
        this.steps.step();
        return replace(from, to, precondition);
      };
    }
  }

  isOpenInEditor(path: string): boolean {
    return this.disk.isOpenInEditor(path);
  }

  list(): Promise<string[]> {
    return this.disk.list();
  }

  read(path: string): Promise<Uint8Array> {
    return this.disk.read(path);
  }

  stat(path: string): Promise<FileStat | null> {
    return this.disk.stat(path);
  }

  watch(listener: VaultListener): () => void {
    return this.disk.watch(listener);
  }

  async write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void> {
    try {
      this.steps.step();
    } catch (error) {
      await this.disk.write(path, data.slice(0, Math.floor(data.length / 2)));
      throw error;
    }
    await this.disk.write(path, data, precondition);
  }

  rename(from: string, to: string): Promise<void> {
    this.steps.step();
    return this.disk.rename(from, to);
  }

  delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    this.steps.step();
    return this.disk.delete(path, precondition);
  }
}

/** A journal whose app can be killed before each commit. */
class CrashingJournal implements SyncJournal {
  constructor(
    readonly stored: MemorySyncJournal,
    private readonly steps: Steps,
  ) {}

  load(): Promise<JournalState> {
    return this.stored.load();
  }

  commit(change: JournalChange): Promise<void> {
    this.steps.step();
    return this.stored.commit(change);
  }
}

/** Every revision on the server, as [document id, path, deleted]. */
function revisions(server: InMemoryServer): [string, string, boolean][] {
  const all: [string, string, boolean][] = [];
  for (let seq = 1n; seq <= server.currentHeadSeq; seq++) {
    const revision = server.revisionAt(seq);
    all.push([revision.documentId, decoder.decode(revision.path), revision.deleted]);
  }
  return all;
}

async function files(vault: VaultAdapter): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of (await vault.list()).sort()) result[path] = decoder.decode(await vault.read(path));
  return result;
}

const image = "png-".repeat(300);

/** Desktop has an atomic replace; mobile replaces a file by a delete and a rename. */
type Platform = "desktop" | "mobile";

/**
 * Device A changes the vault while device B, offline, makes changes of its
 * own. B then syncs, applying A's revisions (a create, an edit, a rename, a
 * delete) and pushing its own (a create, an edit), and is killed at step
 * `crashAt`. It restarts and syncs.
 */
async function killedSync(platform: Platform, crashAt: number): Promise<{ server: InMemoryServer; a: Device; b: VaultAdapter; crashed: boolean; pending: unknown[] }> {
  const server = new InMemoryServer();
  const a = new Device(server, "device-a");
  const steps = new Steps();
  const vault = new CrashingVault(new InMemoryVault({ atomicReplace: platform === "desktop" }), steps);
  const journal = new CrashingJournal(new MemorySyncJournal(), steps);
  server.interceptor = () => {
    steps.step();
  };
  server.responseInterceptor = (method) => {
    // Killed after the server applied the commit: the reply is lost.
    if (method === "CommitRevision") steps.step();
  };
  const engine = () => new SyncEngine({ api: createProtocolClient({ transport: server.transport }), vaultId: server.vaultId, deviceId: "device-b", vault, journal });

  await a.write("keep.md", "v1");
  await a.write("move.md", "moving");
  await a.write("gone.md", "going");
  await a.write("mine.md", "b1");
  await a.sync();
  await engine().sync();

  await a.write("keep.md", "v2");
  await a.vault.rename("move.md", "moved/move.md");
  await a.vault.delete("gone.md");
  await a.write("new.md", "new");
  await a.write("image.png", image);
  await a.sync();
  await vault.disk.write("b.md", encoder.encode("from b"));
  await vault.disk.write("mine.md", encoder.encode("b2"));

  steps.crashAt = crashAt;
  await engine()
    .sync()
    .catch((error: unknown) => {
      // A kill inside a server call reaches the engine as the call's failure.
      if (!steps.crashed) throw error;
    });
  const crashed = steps.crashed;
  steps.crashAt = undefined;
  // The app starts again.
  await engine().sync();
  await a.sync();
  await engine().sync();
  return { server, a, b: vault, crashed, pending: (await journal.load()).pending };
}

describe("an app killed during a sync", () => {
  it.each<Platform>(["desktop", "mobile"])("leaves no half-written or lost file and no duplicate revision, at every step of apply and push (%s)", async (platform) => {
    const expected = { "b.md": "from b", "image.png": image, "keep.md": "v2", "mine.md": "b2", "moved/move.md": "moving", "new.md": "new" };
    let step = 0;
    for (;; step++) {
      const { server, a, b, crashed, pending } = await killedSync(platform, step);
      expect(await files(b), `killed at step ${String(step)}`).toEqual(expected);
      expect(await a.files(), `killed at step ${String(step)}`).toEqual(expected);
      // Four created, A's five changes, B's two.
      expect(revisions(server), `killed at step ${String(step)}`).toHaveLength(11);
      expect(pending, `killed at step ${String(step)}`).toEqual([]);
      if (!crashed) break;
    }
    // The sync has steps to be killed at: downloads, writes, journal commits, uploads and commits.
    expect(step).toBeGreaterThan(20);
  });
});

describe("a journal write failure", () => {
  it("stops the cycle before anything is pushed, shows the error, and retries with backoff", async () => {
    const server = new InMemoryServer();
    const steps = new Steps();
    const vault = new InMemoryVault();
    const journal = new CrashingJournal(new MemorySyncJournal(), steps);
    const timers = new ManualTimers();
    const engine = new SyncEngine({ api: createProtocolClient({ transport: server.transport }), vaultId: server.vaultId, deviceId: "device-a", vault, journal, timers, random: () => 0 });
    await vault.write("a.md", encoder.encode("one"));
    // The journal refuses the write that records the pending create.
    steps.crashAt = 0;
    engine.start();
    await settle();
    expect(engine.status).toBe("error");
    expect(engine.lastError).toBeInstanceOf(Crash);
    expect(server.revisionCount).toBe(0);
    // The backoff's first retry, half of its initial second with no jitter.
    expect(timers.delays()).toContain(500);
    timers.fire(500);
    await settle();
    engine.stop();
    expect(engine.status).toBe("idle");
    expect(revisions(server)).toHaveLength(1);
    expect((await journal.load()).pending).toEqual([]);
  });
});

describe("temporary files", () => {
  it("left by a crash are deleted at startup and never pushed", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a");
    await a.write("notes/a.md.vault-sync-tmp", "half of a");
    await a.write("b.md", "b");
    await a.sync();
    expect(await a.files()).toEqual({ "b.md": "b" });
    expect(revisions(server)).toEqual([[expect.any(String), "b.md", false]]);
  });

  it("a replacement file whose target is missing is renamed into place at startup (mobile)", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a", {}, { atomicReplace: false });
    await a.write("a.md", "old");
    await a.write("b.md", "b");
    await a.write("b.md.vault-sync-new", "maybe half");
    // Killed after the replacement of a.md was complete and its target deleted.
    await a.write("a.md.vault-sync-new", "new");
    await a.vault.delete("a.md");
    server.interceptor = () => {
      throw new Error("offline");
    };
    await expect(a.sync()).rejects.toThrow();
    expect(await a.files()).toEqual({ "a.md": "new", "b.md": "b" });
  });

  it("a file open in the editor is written in place, not replaced", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a");
    const b = new Device(server, "device-b");
    await a.write("open.md", "one");
    await a.write("closed.md", "one");
    await a.sync();
    await b.sync();
    b.vault.openInEditor.add("open.md");
    const touched: string[] = [];
    b.vault.tapInodes((event) => {
      touched.push(event.path);
    });
    await a.write("open.md", "two");
    await a.write("closed.md", "two");
    await a.sync();
    await b.sync();
    expect(await b.files()).toEqual({ "closed.md": "two", "open.md": "two" });
    expect(touched).toEqual(["open.md", "closed.md.vault-sync-tmp", "closed.md.vault-sync-tmp", "closed.md"]);
  });
});
