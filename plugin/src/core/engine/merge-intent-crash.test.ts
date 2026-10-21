// Refactor step R8 (docs/design/engine-path-ownership.md §4.4, PO-8): a
// remote revision is applied or merged as an `apply` or `merge` intent,
// recorded before the first disk step and finished by one journal
// transaction that also moves the cursor. A crash after any durable change
// of the pull, journal or disk, and a restart, reaches the state a run
// without the crash reaches (INV-7): the written file is never taken for a
// new document (#392), and a conflict copy is written and logged once.

import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import type { VaultAdapter } from "../vault/adapter";
import { VaultError } from "../vault/adapter";
import type { PathPlatform } from "../vaultpath/platform";
import { InMemoryServer } from "./memory-server";
import { threeWayMerge, type MergeHook } from "./merge";
import { copyOf, Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness, type Harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);
const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");
/** More than the durable changes of any pull below: the last ones change nothing. */
const crashPoints = Array.from({ length: 14 }, (_, index) => index + 1);

function crashingDevice(server: InMemoryServer, points: CrashPoints, platform: PathPlatform, merge: MergeHook | "default" = "default"): Harness {
  const vault = new InMemoryVault({ pathRules: { platform } });
  return harness({ merge, server, vault, journal: new CrashingJournal(points), pathRules: { platform }, wrapVault: (inner) => new CrashingVault(inner, points) });
}

/** Pulls, crashing after durable change `crashAfter` (0: no crash), and restarts the engine over the same vault and journal. */
async function pullAndCrash(device: Harness, points: CrashPoints, crashAfter: number): Promise<void> {
  points.count = 0;
  points.crashAfter = crashAfter;
  try {
    await device.engine.pull();
  } catch (error) {
    if (!(error instanceof Crash)) throw error;
  } finally {
    points.crashAfter = 0;
  }
  device.restart();
}

async function settle(device: Harness): Promise<void> {
  for (let round = 0; round < 4; round++) await device.engine.push();
}

describe.each(["posix", "windows", "macos"] as const)("a pull interrupted by a crash (%s)", (platform) => {
  describe("while it merges a remote rename into a locally edited note, with a file in the way and overlapping edits", () => {
    async function scenario(crashAfter: number) {
      const server = new InMemoryServer();
      const points = new CrashPoints();
      const device = crashingDevice(server, points, platform);
      server.commit({ documentId: "N", path: "a.md", content: lines("one", "two") });
      await device.engine.pull();
      await device.vault.write("a.md", bytes(lines("one (local)", "two")));
      // A file the user created where the remote rename takes the note.
      await device.vault.write("c.md", bytes(lines("unrelated")));
      server.commit({ documentId: "N", path: "c.md", content: lines("one (remote)", "two") });
      await pullAndCrash(device, points, crashAfter);
      await settle(device);
      return { server, device };
    }

    it.each(crashPoints)("ends as without a crash, every version kept once, after durable change %i", async (crashAfter) => {
      const { server, device } = await scenario(crashAfter);
      const baseline = await scenario(0);

      expect(await files(device.vault)).toEqual(server.liveFiles());
      expect(server.liveFiles()).toEqual(baseline.server.liveFiles());
      expect(server.liveDocuments().get("c.md")).toBe("N");
      expect([...server.liveFiles().values()].sort()).toEqual([lines("one (local)", "two"), lines("one (remote)", "two"), lines("unrelated")].sort());
      expect((await device.journal.listConflicts()).map((record) => [record.reason, record.copyPath])).toEqual(
        (await baseline.device.journal.listConflicts()).map((record) => [record.reason, record.copyPath]),
      );
      expect(await device.journal.listPending()).toEqual([]);
      expect(await device.journal.listDeferred()).toEqual([]);
      expect(await device.journal.listIntents()).toEqual([]);
    });
  });

  describe("while a push merges a remote revision whose merge the hook deferred before", () => {
    async function scenario(crashAfter: number) {
      const server = new InMemoryServer();
      const points = new CrashPoints();
      let calls = 0;
      // Defers the first merge, so the revision waits as a deferral the push's retry merges.
      const merge: MergeHook = (request) => (calls++ === 0 ? Promise.resolve({ status: "deferred" }) : threeWayMerge(request));
      const device = crashingDevice(server, points, platform, merge);
      server.commit({ documentId: "N", path: "a.md", content: lines("one", "two") });
      await device.engine.pull();
      await device.vault.write("a.md", bytes(lines("one (local)", "two")));
      server.commit({ documentId: "N", path: "c.md", content: lines("one (remote)", "two") });
      await device.engine.pull();
      expect(await device.journal.listDeferred()).toHaveLength(1);
      points.count = 0;
      points.crashAfter = crashAfter;
      try {
        await device.engine.push();
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
      } finally {
        points.crashAfter = 0;
      }
      device.restart();
      await settle(device);
      return { server, device };
    }

    it.each(crashPoints)("ends as without a crash, the deferral gone, after durable change %i", async (crashAfter) => {
      const { server, device } = await scenario(crashAfter);
      const baseline = await scenario(0);

      expect(server.liveFiles()).toEqual(baseline.server.liveFiles());
      expect(await files(device.vault)).toEqual(server.liveFiles());
      expect(server.liveDocuments().get("c.md")).toBe("N");
      expect(await device.journal.listDeferred()).toEqual([]);
      expect(await device.journal.listPending()).toEqual([]);
      expect(await device.journal.listIntents()).toEqual([]);
    });
  });

  describe("while it applies a remote create (#392)", () => {
    async function scenario(crashAfter: number) {
      const server = new InMemoryServer();
      const points = new CrashPoints();
      const device = crashingDevice(server, points, platform);
      server.commit({ documentId: "R", path: "NOTES/d.md", content: "remote\n" });
      await pullAndCrash(device, points, crashAfter);
      await settle(device);
      return { server, device };
    }

    it.each(crashPoints)("takes the written file for the remote document, never a new one, after durable change %i", async (crashAfter) => {
      const { server, device } = await scenario(crashAfter);

      expect(await files(device.vault)).toEqual(new Map([["NOTES/d.md", "remote\n"]]));
      expect(server.liveDocuments()).toEqual(new Map([["NOTES/d.md", "R"]]));
      expect(device.acknowledged).toEqual([]);
      expect(await device.journal.listPending()).toEqual([]);
      expect(await device.journal.listIntents()).toEqual([]);
    });
  });
});

describe.each(["posix", "windows", "macos"] as const)("a push interrupted by a crash while the pull it starts applies a revision that waited for its path (#392, %s)", (platform) => {
  /** The other device has NOTES/d.md; this one creates the file notes, in the way of its folder. */
  async function scenario(crashAfter: number) {
    const server = new InMemoryServer();
    const other = harness({ merge: "default", server, idPrefix: "o", deviceName: "other", pathRules: { platform } });
    const points = new CrashPoints();
    const device = crashingDevice(server, points, platform);
    await other.vault.write("NOTES/d.md", bytes("other\n"));
    await other.engine.push();
    await device.vault.write("notes", bytes("mine\n"));
    await device.engine.pull();
    points.count = 0;
    points.crashAfter = crashAfter;
    try {
      await device.engine.push();
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    } finally {
      points.crashAfter = 0;
    }
    device.restart();
    await settle(device);
    return { server, device };
  }

  it.each(crashPoints)("keeps the other document's file its own, live once, after durable change %i", async (crashAfter) => {
    const { server, device } = await scenario(crashAfter);

    expect(await files(device.vault)).toEqual(server.liveFiles());
    expect([...server.liveFiles().values()].filter((content) => content === "other\n")).toHaveLength(1);
    expect([...server.liveFiles().values()].filter((content) => content === "mine\n")).toHaveLength(1);
    expect(await device.journal.listIntents()).toEqual([]);
  });
});

/** A vault that refuses the next rename onto `target` as a path conflict. */
function refusingRename(inner: VaultAdapter, target: string): VaultAdapter & { armed: boolean } {
  const wrapped = Object.create(inner) as VaultAdapter & { armed: boolean };
  wrapped.armed = true;
  wrapped.rename = (from, to) => {
    if (wrapped.armed && to === target) {
      wrapped.armed = false;
      return Promise.reject(new VaultError("path-conflict", to));
    }
    return inner.rename(from, to);
  };
  return wrapped;
}

describe("a merge whose result the vault refuses after its conflict copy is written (#345)", () => {
  it("logs the copy and pushes it with the next push, without a restart", async () => {
    let vault: (VaultAdapter & { armed: boolean }) | undefined;
    const h = harness({
      merge: "default",
      wrapVault: (inner) => {
        vault = refusingRename(inner, "c.md");
        return vault;
      },
    });
    h.server.commit({ documentId: "N", path: "a.md", content: lines("one", "two") });
    await h.engine.pull();
    await h.vault.write("a.md", bytes(lines("one (local)", "two")));
    h.server.commit({ documentId: "N", path: "c.md", content: lines("one (remote)", "two") });

    // The merge writes the copy of the local version, then the vault refuses the rename.
    expect(await h.engine.pull()).toMatchObject({ deferred: 1, merged: 0 });
    const copy = copyOf("a", ".md");
    expect((await h.journal.listConflicts()).map((record) => [record.reason, record.copyPath])).toEqual([["overlapping-edits", copy]]);
    expect(vault?.armed).toBe(false);

    await h.engine.push();

    // The copy is a document of its own on the server after this push, not only after the next start.
    expect(h.server.liveFiles().get(copy)).toBe(lines("one (local)", "two"));
    await h.engine.push();
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(h.server.liveDocuments().get("c.md")).toBe("N");
  });
});
