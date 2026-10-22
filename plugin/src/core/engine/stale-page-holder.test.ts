// #792 (PO-4(b), PO-11; INV-1, INV-3): a feed page that moves a document D,
// whose file holds the user's unsynced edit, to a path this platform cannot
// hold, gives D's old path to another document, and later on the same page
// moves D to a path the device can hold. Rule W decides on D's newest server
// claim the pull has in hand: D follows its head under its own id, keeping the
// edit, and nothing is detached as a new document.

import { describe, expect, it } from "vitest";

import { PropertyWorld, withoutCopyNames, type WorldCommand } from "./testing";

async function play(...commands: WorldCommand[]): Promise<PropertyWorld> {
  const world = new PropertyWorld("windows");
  for (const command of commands) await world.apply(command);
  return world;
}

function copies(world: PropertyWorld): string[] {
  return [...world.server.liveFiles().keys()].filter((path) => withoutCopyNames(path) !== path);
}

describe("a stale intermediate revision on a feed page", () => {
  it("lets the document follow its head to a path the device can hold, with the user's edit", async () => {
    const world = await play(
      { type: "remote-create", path: 0 }, // D at a.md
      { type: "pull" },
      { type: "user-edit", file: 0 }, // step 3: "user 3"
      { type: "remote-rename", document: 0, path: 11 }, // D -> no:te.md, which Windows cannot hold
      { type: "remote-create", path: 0 }, // E takes a.md
      { type: "remote-rename", document: 1, path: 2 }, // D -> b.md
      { type: "pull" }, // one page of three revisions
      { type: "push" },
    );
    expect(world.errors).toEqual([]);
    expect(copies(world)).toEqual([]);
    const files = world.server.liveFiles();
    expect(files.get("b.md")).toBe("user 3");
    expect(files.get("a.md")).toMatch(/^remote /);
    expect(world.server.head("r-1")?.contentRef).toBeDefined();
    expect(new TextDecoder().decode(world.server.head("r-1")?.path)).toBe("b.md");
  });

  it("lets the document follow its head back to its own path once the other document is deleted", async () => {
    const world = await play(
      { type: "remote-create", path: 0 }, // D at a.md
      { type: "pull" },
      { type: "user-edit", file: 0 }, // step 3: "user 3"
      { type: "remote-rename", document: 0, path: 11 }, // D -> no:te.md
      { type: "pull" }, // D's revision waits, unmaterializable; the device keeps the edited a.md
      { type: "remote-create", path: 0 }, // E takes a.md
      { type: "remote-delete", document: 0 }, // E deleted
      { type: "remote-rename", document: 0, path: 0 }, // D back to a.md
      { type: "pull" }, // one page of three revisions
      { type: "push" },
    );
    expect(world.errors).toEqual([]);
    expect(copies(world)).toEqual([]);
    expect([...world.server.liveFiles()]).toEqual([["a.md", "user 3"]]);
    expect(new TextDecoder().decode(world.server.head("r-1")?.path)).toBe("a.md");
  });
});

// #803 (PO-4(b), PO-11; INV-3): as above, but D's newer revision is on the
// feed's next page (three revisions a page). Rule W(b) does not detach D on
// one page's knowledge: the revision claiming D's path waits until the pull
// has drained the feed, by when D has followed its head.
describe("a stale intermediate revision on an earlier feed page", () => {
  it("lets the document follow its head on the next page to a path the device can hold, with the user's edit", async () => {
    const world = await play(
      { type: "remote-create", path: 0 }, // D at a.md
      { type: "pull" },
      { type: "user-edit", file: 0 }, // step 3: "user 3"
      { type: "remote-create", path: 5 }, // F at Straße.md, which fills the first page
      { type: "remote-rename", document: 1, path: 11 }, // D -> no:te.md (live: Straße.md, a.md)
      { type: "remote-create", path: 0 }, // E takes a.md
      { type: "remote-rename", document: 2, path: 2 }, // D -> b.md, on the next page (live: Straße.md, a.md, no:te.md)
      { type: "pull" },
      { type: "push" },
    );
    expect(world.errors).toEqual([]);
    expect(copies(world)).toEqual([]);
    const files = world.server.liveFiles();
    expect(files.get("b.md")).toBe("user 3");
    expect(files.get("a.md")).toMatch(/^remote /);
    expect(new TextDecoder().decode(world.server.head("r-1")?.path)).toBe("b.md");
  });

  it("lets the document follow its head on the next page back to its own path once the other document is deleted", async () => {
    const world = await play(
      { type: "remote-create", path: 0 }, // D at a.md
      { type: "pull" },
      { type: "user-edit", file: 0 }, // step 3: "user 3"
      { type: "remote-create", path: 5 }, // F at Straße.md, which fills the first page
      { type: "remote-rename", document: 1, path: 11 }, // D -> no:te.md
      { type: "remote-create", path: 0 }, // E takes a.md
      { type: "remote-delete", document: 1 }, // E deleted, on the next page (live: Straße.md, a.md, no:te.md)
      { type: "remote-rename", document: 1, path: 0 }, // D back to a.md (live: Straße.md, no:te.md)
      { type: "pull" },
      { type: "push" },
    );
    expect(world.errors).toEqual([]);
    expect(copies(world)).toEqual([]);
    const files = world.server.liveFiles();
    expect(files.get("a.md")).toBe("user 3");
    expect(new TextDecoder().decode(world.server.head("r-1")?.path)).toBe("a.md");
  });

  it("detaches the document once the pull has drained the feed if its newest claim is still one the device cannot hold", async () => {
    const world = await play(
      { type: "remote-create", path: 0 }, // D at a.md
      { type: "pull" },
      { type: "user-edit", file: 0 }, // step 3: "user 3"
      { type: "remote-create", path: 5 }, // F at Straße.md, which fills the first page
      { type: "remote-rename", document: 1, path: 11 }, // D -> no:te.md
      { type: "remote-create", path: 0 }, // E takes a.md
      { type: "remote-create", path: 3 }, // G at Café.md, on the next page
      { type: "pull" },
    );
    expect(world.errors).toEqual([]);
    // E has its path, and the user's edit stays, as an untracked copy (PO-11).
    const files = await world.vault.list();
    expect(await world.vault.read("a.md").then((bytes) => new TextDecoder().decode(bytes))).toMatch(/^remote /);
    const copy = files.find((path) => withoutCopyNames(path) !== path) ?? "";
    expect(copy).toMatch(/^a \(conflict .*\)\.md$/);
    expect(new TextDecoder().decode(await world.vault.read(copy))).toBe("user 3");
  });
});

// #803 item 2: the followed revision is decided inside the step of the
// revision being applied (E's), but the cursor moves only in E's own step.
// A crash after the followed revision commits, before E's step moves the
// cursor, leaves the cursor before E: the restarted pull applies E, and D's
// followed revision is not applied twice.
describe("a crash while a document follows its newer revision on the feed page", () => {
  it("leaves the cursor before the revision being applied, at every journal write", async () => {
    for (let write = 1; write <= 10; write++) {
      const world = await play(
        { type: "remote-create", path: 0 }, // D at a.md
        { type: "pull" },
        { type: "user-edit", file: 0 }, // step 3: "user 3"
        { type: "remote-rename", document: 0, path: 11 }, // D -> no:te.md
        { type: "remote-create", path: 0 }, // E takes a.md
        { type: "remote-rename", document: 1, path: 2 }, // D -> b.md
        { type: "crash", write },
        { type: "pull" }, // one page of three revisions; the engine restarts and pulls again
        { type: "push" },
      );
      const context = `crash at write ${String(write)}`;
      expect(world.crashes, context).toBe(1);
      expect(world.errors, context).toEqual([]);
      expect(copies(world), context).toEqual([]);
      const files = world.server.liveFiles();
      expect(files.get("b.md"), context).toBe("user 3");
      expect(files.get("a.md"), context).toMatch(/^remote /);
      expect(await world.vault.read("a.md").then((bytes) => new TextDecoder().decode(bytes)), context).toMatch(/^remote /);
      expect(await world.journal.getCursor(), context).toBe(world.server.currentHeadSeq);
    }
  });
});
