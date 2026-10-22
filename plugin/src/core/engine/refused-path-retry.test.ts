import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { files, twoDevices } from "./testing";

// A remote revision the vault refused because an untracked file is in its
// way (a `path-conflict` deferral) is applied once that file is gone (design
// §4.5 W(b), PO-4(b), INV-9; SyncEngine.retryRefusedPaths). The file is in
// the way under F: on a case-folding device `Notes/c.md` is in a folder the
// file `NOTES` would be (#843).

const bytes = (value: string) => new TextEncoder().encode(value);

describe("a remote revision refused for an untracked file in the way", () => {
  it("is applied once the user removes a file in a folder of another spelling that was in its way (#843)", async () => {
    const devices = twoDevices({ pathRules: { platform: "macos" } });
    await devices.a.vault.write("NOTES", bytes("from a\n"));
    await devices.a.engine.push();

    // An untracked file in `Notes/`, which is the folder `NOTES` would be on this device.
    await devices.b.vault.write("Notes/c.md", bytes("from b\n"));
    await devices.b.engine.pull();
    expect((await devices.b.journal.listDeferred()).map((deferred) => [deferred.revision.path, deferred.reason])).toEqual([["NOTES", "path-conflict"]]);

    // A push whose commits fail: its retry of the refused revision runs while the file is still in the way.
    devices.b.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
    };
    await devices.b.engine.push().catch(() => undefined);
    devices.b.server.interceptor = undefined;

    // The user removes the file; the next push applies the revision.
    await devices.b.vault.delete("Notes/c.md");
    await devices.b.engine.push();

    expect(await files(devices.b.vault)).toEqual(new Map([["NOTES", "from a\n"]]));
    expect(await devices.b.journal.listDeferred()).toEqual([]);
  });

  it("is applied once the user removes a file where its path needs a folder of another spelling (#854)", async () => {
    const devices = twoDevices({ pathRules: { platform: "macos" } });
    await devices.a.vault.write("notes/a.md", bytes("from a\n"));
    await devices.a.engine.push();

    // An untracked file `NOTES`, where `notes/a.md` needs a folder on this device.
    await devices.b.vault.write("NOTES", bytes("from b\n"));
    await devices.b.engine.pull();
    expect((await devices.b.journal.listDeferred()).map((deferred) => [deferred.revision.path, deferred.reason])).toEqual([["notes/a.md", "path-conflict"]]);

    // A push whose commits fail: its retry of the refused revision runs while the file is still in the way.
    devices.b.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
    };
    await devices.b.engine.push().catch(() => undefined);
    devices.b.server.interceptor = undefined;

    // The user removes the file; the next push applies the revision.
    await devices.b.vault.delete("NOTES");
    await devices.b.engine.push();

    expect(await files(devices.b.vault)).toEqual(new Map([["notes/a.md", "from a\n"]]));
    expect(await devices.b.journal.listDeferred()).toEqual([]);
  });

  it("is applied with a revision that waited for the holder it moves off the path (#843)", async () => {
    const devices = twoDevices({ pathRules: { platform: "macos" } });
    await devices.a.vault.write("h.md", bytes("holder\n"));
    await devices.a.engine.push();
    await devices.b.engine.pull();

    // The holder moves to `NOTES`, and another document takes its old path.
    await devices.a.vault.rename("h.md", "NOTES");
    await devices.a.engine.push();
    await devices.a.vault.write("h.md", bytes("taker\n"));
    await devices.a.engine.push();

    // On b an untracked file in `Notes/` keeps the holder at `h.md`, so the taker waits for it.
    await devices.b.vault.write("Notes/c.md", bytes("from b\n"));
    await devices.b.engine.pull();
    expect((await devices.b.journal.listDeferred()).map((deferred) => [deferred.revision.path, deferred.reason]).sort()).toEqual([
      ["NOTES", "path-conflict"],
      ["h.md", "path-conflict"],
    ]);

    // A push whose commits fail tries the waiting revisions while the file is still in the way.
    devices.b.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
    };
    await devices.b.engine.push().catch(() => undefined);
    devices.b.server.interceptor = undefined;

    await devices.b.vault.delete("Notes/c.md");
    await devices.b.engine.push();

    expect(await files(devices.b.vault)).toEqual(
      new Map([
        ["NOTES", "holder\n"],
        ["h.md", "taker\n"],
      ]),
    );
    expect(await devices.b.journal.listDeferred()).toEqual([]);
  });
});
