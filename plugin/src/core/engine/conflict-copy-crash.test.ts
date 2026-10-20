// A create refused with ALREADY_EXISTS moves to a conflict-copy path in
// several durable steps (SPEC.md §7): the conflict record, the file's rename,
// the replacement operation, the refused operation's removal. A crash after
// any of them must end the same as no crash (#371), also when the user then
// deletes or moves the copy (#372).

import { describe, expect, it } from "vitest";

import type { PathPlatform } from "../vaultpath/platform";
import { InMemoryVault } from "../vault/memory";
import { InMemoryServer } from "./memory-server";
import { Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness, type Harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);
const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };
/** Enough to reach every durable change of the push that moves the file: the last ones commit the copy. */
const crashPoints = [1, 2, 3, 4, 5, 6, 7, 8];

/** A device whose journal and vault changes are crash points. */
function crashingDevice(server: InMemoryServer, points: CrashPoints, platform: PathPlatform, idPrefix: string, deviceName: string): Harness {
  const vault = new InMemoryVault({ pathRules: { platform } });
  return harness({ merge: "default", server, vault, journal: new CrashingJournal(points), idPrefix, deviceName, pathRules: { platform }, wrapVault: (inner) => new CrashingVault(inner, points) });
}

/** Pushes, crashing after durable change `crashAfter`, and restarts the engine over the same vault and journal. */
async function pushAndCrash(device: Harness, points: CrashPoints, crashAfter: number): Promise<void> {
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
}

async function pushUntilQuiet(device: Harness): Promise<unknown[]> {
  const summaries = [];
  for (let round = 0; round < 4; round++) summaries.push(await device.engine.push());
  return summaries;
}

describe.each(["posix", "macos", "windows"] as const)("a create refused because another document holds its folder, interrupted while moving to its conflict copy (%s)", (platform) => {
  /** The other device has the folder NOTES/; this one creates the file notes, which the server refuses. */
  async function refusedCreate() {
    const server = new InMemoryServer();
    const other = harness({ merge: "default", server, idPrefix: "o", deviceName: "other", pathRules: { platform } });
    const points = new CrashPoints();
    const device = crashingDevice(server, points, platform, "h", "dev0");
    await other.vault.write("NOTES/d.md", bytes("other\n"));
    await other.engine.push();
    await device.vault.write("notes", bytes("mine\n"));
    await device.engine.pull();
    return { server, other, points, device };
  }

  it.each(crashPoints)("converges with nothing pending once the folder goes away, after a crash after durable change %i", async (crashAfter) => {
    const { server, other, points, device } = await refusedCreate();
    await pushAndCrash(device, points, crashAfter);
    await other.vault.rename("NOTES/d.md", "A.md");
    await other.engine.push();

    const summaries = await pushUntilQuiet(device);

    expect(summaries.at(-1)).toEqual(quiet);
    expect(await device.journal.listPending()).toEqual([]);
    expect(await files(device.vault)).toEqual(server.liveFiles());
    // The note is live once, at the original path or its conflict copy.
    expect([...server.liveFiles().values()].filter((content) => content === "mine\n")).toHaveLength(1);
    // Its document never lands where its file is not: no commit there, and no delete of it after.
    expect(device.acknowledged.filter((revision) => revision.deleted)).toEqual([]);
  });

  it.each(crashPoints)("commits the note once, at its conflict-copy path, while the folder stays, after a crash after durable change %i", async (crashAfter) => {
    const { server, points, device } = await refusedCreate();
    await pushAndCrash(device, points, crashAfter);

    const summaries = await pushUntilQuiet(device);

    expect(summaries.at(-1)).toEqual(quiet);
    expect(await device.journal.listPending()).toEqual([]);
    expect(server.liveFiles()).toEqual(
      new Map([
        ["NOTES/d.md", "other\n"],
        ["notes (conflict dev0 2026-10-18 040506)", "mine\n"],
      ]),
    );
    expect(await files(device.vault)).toEqual(server.liveFiles());
    // Nothing else was ever committed for it (a crash may come before the commit is reported).
    for (const revision of device.acknowledged) expect([revision.path, revision.deleted]).toEqual(["notes (conflict dev0 2026-10-18 040506)", false]);
  });
});

describe("a create refused for a case-only collision, interrupted while moving to its conflict copy, whose copy the user then deletes or moves", () => {
  /** Under POSIX rules: the other device committed NOTES first, this one created notes. */
  async function refusedCreate() {
    const server = new InMemoryServer();
    const other = harness({ merge: "default", server, idPrefix: "a", deviceName: "dev0" });
    const points = new CrashPoints();
    const device = crashingDevice(server, points, "posix", "b", "dev1");
    await other.vault.write("NOTES", bytes("first\n"));
    await device.vault.write("notes", bytes("second\n"));
    await other.engine.push();
    await device.engine.pull();
    return { server, points, device };
  }

  const copyOf = async (device: Harness) => [...(await files(device.vault)).keys()].find((path) => path.includes("(conflict "));

  it.each(crashPoints)("drops the refused create and commits nothing for the deleted copy, after a crash after durable change %i", async (crashAfter) => {
    const { server, points, device } = await refusedCreate();
    await pushAndCrash(device, points, crashAfter);
    const copy = await copyOf(device);
    if (copy !== undefined) await device.vault.delete(copy);

    const summaries = await pushUntilQuiet(device);

    expect(summaries.at(-1)).toEqual(quiet);
    expect(await device.journal.listPending()).toEqual([]);
    expect(await files(device.vault)).toEqual(server.liveFiles());
    // The user deleted the copy: its content is not live on the server.
    if (copy !== undefined) expect(server.liveFiles()).toEqual(new Map([["NOTES", "first\n"]]));
  });

  it.each(crashPoints)("pushes the moved copy once, at the path the user chose, after a crash after durable change %i", async (crashAfter) => {
    const { server, points, device } = await refusedCreate();
    await pushAndCrash(device, points, crashAfter);
    const copy = await copyOf(device);
    if (copy !== undefined) await device.vault.rename(copy, "kept.md");

    const summaries = await pushUntilQuiet(device);

    expect(summaries.at(-1)).toEqual(quiet);
    expect(await device.journal.listPending()).toEqual([]);
    expect(await files(device.vault)).toEqual(server.liveFiles());
    const live = server.liveFiles();
    expect([...live.values()].filter((content) => content === "second\n")).toHaveLength(1);
    if (copy !== undefined) expect(live.get("kept.md")).toBe("second\n");
  });
});
