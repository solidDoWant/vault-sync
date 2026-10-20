import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { InMemoryServer } from "./memory-server";
import { Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("a create that loses a path-key race, crash during the conflict-copy move", () => {
  it.each([1, 2, 3, 4, 5, 6])("quiesces after a crash after durable change %i and the user deleting the copy", async (crashAfter) => {
    const server = new InMemoryServer();
    const a = harness({ merge: "default", server, idPrefix: "a", deviceName: "dev0" });
    const points = new CrashPoints();
    const vault = new InMemoryVault();
    const b = harness({ merge: "default", server, vault, journal: new CrashingJournal(points), idPrefix: "b", deviceName: "dev1", wrapVault: (inner) => new CrashingVault(inner, points) });

    await a.vault.write("NOTES", bytes("first\n"));
    await b.vault.write("notes", bytes("second\n"));
    await a.engine.push();
    await b.engine.pull();

    points.count = 0;
    points.crashAfter = crashAfter;
    let crashed = false;
    try {
      await b.engine.push();
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      crashed = true;
    }
    points.crashAfter = 0;
    b.restart();
    const before = await files(b.vault);
    const copy = [...before.keys()].find((path) => path.includes("conflict"));
    if (copy !== undefined) await b.vault.delete(copy);

    const summaries = [];
    for (let round = 0; round < 4; round++) summaries.push(await b.engine.push());
    console.log(crashAfter, crashed, JSON.stringify([...before]), JSON.stringify(summaries), JSON.stringify(await b.journal.listPending(), (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)));
    expect(summaries.at(-1)).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
    expect(await b.journal.listPending()).toEqual([]);
  });

  it("quiesces without a crash when the user deletes the conflict copy before it is pushed", async () => {
    const server = new InMemoryServer();
    const a = harness({ merge: "default", server, idPrefix: "a", deviceName: "dev0" });
    const b = harness({ merge: "default", server, idPrefix: "b", deviceName: "dev1" });
    await a.vault.write("NOTES", bytes("first\n"));
    await b.vault.write("notes", bytes("second\n"));
    await a.engine.push();
    await b.engine.pull();
    // The commit of `notes` is lost after the server refused it: the push fails mid-way.
    let failed = false;
    server.responseInterceptor = (method) => {
      if (method === "CommitRevision" && !failed) {
        failed = true;
        throw new Error("connection lost");
      }
    };
    await b.engine.push().catch(() => undefined);
    server.responseInterceptor = undefined;
    console.log("nocrash", JSON.stringify([...(await files(b.vault))]));
    const copy = [...(await files(b.vault)).keys()].find((path) => path.includes("conflict"));
    if (copy !== undefined) await b.vault.delete(copy);
    const summaries = [];
    for (let round = 0; round < 4; round++) summaries.push(await b.engine.push());
    console.log("nocrash", JSON.stringify(summaries));
    expect(summaries.at(-1)).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
  });
});
