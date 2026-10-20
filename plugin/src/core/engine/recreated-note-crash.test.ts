// A pull that brings a deleted note's tombstone and a new document at the same
// path, onto a device that edited the deleted note, applies in several durable
// steps. A crash after any of them must end the same as no crash: the edit
// survives as a conflict copy, and nothing stays deferred (#453).

import { describe, expect, it } from "vitest";

import type { PathPlatform } from "../vaultpath/platform";
import { InMemoryVault } from "../vault/memory";
import { InMemoryServer } from "./memory-server";
import { Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);
/** No crash, then every durable change of the pull and a few past its end. */
const crashPoints = [0, 1, 2, 3, 4, 5, 6, 7, 8];

describe.each(["posix", "windows"] as const)("a pull bringing a deleted and recreated note onto a device that edited it, interrupted (%s)", (platform: PathPlatform) => {
  it.each(crashPoints)("converges with the edit kept and nothing deferred, after a crash after durable change %i", async (crashAfter) => {
    const server = new InMemoryServer({ maxPageSize: 3, maxDownloadBytes: 64 });
    const a = harness({ merge: "default", server, idPrefix: "a", deviceName: "a", pathRules: { platform } });
    const points = new CrashPoints();
    const b = harness({
      merge: "default",
      server,
      vault: new InMemoryVault({ pathRules: { platform } }),
      journal: new CrashingJournal(points),
      idPrefix: "b",
      deviceName: "b",
      pathRules: { platform },
      wrapVault: (inner) => new CrashingVault(inner, points),
    });
    await a.vault.write("Notes/C.md", bytes("w1\n"));
    await a.engine.push();
    await a.vault.delete("Notes/C.md");
    await a.engine.settled();
    await b.engine.pull();
    await b.vault.write("Notes/C.md", bytes("w2\n"));
    await b.engine.settled();
    await a.vault.write("Notes/C.md", bytes("w3\n"));
    await a.engine.settled();
    await a.engine.push();

    points.count = 0;
    points.crashAfter = crashAfter;
    try {
      await b.engine.pull();
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    } finally {
      points.crashAfter = 0;
    }
    b.restart();
    for (let round = 0; round < 4; round++) {
      await b.engine.push();
      await a.engine.push();
    }
    await a.engine.pull();
    await b.engine.pull();
    b.restart();
    await b.engine.push();
    await b.engine.pull();

    expect(await files(b.vault)).toEqual(server.liveFiles());
    const live = [...server.liveFiles().entries()];
    expect(live.filter(([, content]) => content === "w3\n").map(([path]) => path)).toEqual(["Notes/C.md"]);
    // B's edit of the deleted note is on the server, once.
    expect(live.filter(([, content]) => content === "w2\n")).toHaveLength(1);
    expect(await b.journal.listDeferred()).toEqual([]);
    expect(await b.journal.listPending()).toEqual([]);
  });
});
