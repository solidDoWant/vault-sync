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
