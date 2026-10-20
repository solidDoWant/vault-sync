import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { InMemoryServer } from "./memory-server";
import { Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);

describe.each(["posix", "macos", "windows"] as const)("a create refused for a path-key collision, crash mid-move, holder goes away (%s)", (platform) => {
  it.each([1, 2, 3, 4, 5, 6, 7])("converges after a crash after durable change %i", async (crashAfter) => {
    const server = new InMemoryServer();
    const other = harness({ merge: "default", server, idPrefix: "o", deviceName: "other", pathRules: { platform } });
    const points = new CrashPoints();
    const vault = new InMemoryVault({ pathRules: { platform } });
    const h = harness({ merge: "default", server, vault, journal: new CrashingJournal(points), idPrefix: "h", deviceName: "dev0", pathRules: { platform }, wrapVault: (inner) => new CrashingVault(inner, points) });

    await other.vault.write("NOTES/d.md", bytes("other\n"));
    await other.engine.push();
    await h.vault.write("notes", bytes("mine\n"));
    await h.engine.pull();

    points.count = 0;
    points.crashAfter = crashAfter;
    let crashed = false;
    try {
      await h.engine.push();
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      crashed = true;
    }
    points.crashAfter = 0;
    h.restart();
    await other.vault.rename("NOTES/d.md", "A.md");
    await other.engine.push();

    const summaries = [];
    for (let round = 0; round < 4; round++) summaries.push(await h.engine.push());
    await other.engine.pull();
    console.log(platform, crashAfter, crashed, JSON.stringify(summaries), JSON.stringify([...server.liveFiles()]), JSON.stringify([...(await files(h.vault))]));
    expect(summaries.at(-1)).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
    expect(await files(h.vault)).toEqual(server.liveFiles());
  });
});
