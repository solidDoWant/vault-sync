import { describe, expect, it } from "vitest";

import { PropertyWorld, type WorldCommand } from "./testing";

// #906 (INV-7, PO-2): another device deletes a note this device renamed and
// has not pushed yet. While the pull applying the delete reads the note's
// synced path, the user moves the file back there, so nothing is left of
// the local rename. Another device has meanwhile created a note at that path
// with the same bytes. The delete applies as it would against an untouched
// file (and as an engine restarted after the user's move applies it), so no
// conflict copy brings the deleted note back.

describe("SyncEngine applying a remote delete while the user moves the renamed file back", () => {
  it("applies the delete and keeps no copy of the deleted note", async () => {
    const steps: WorldCommand[] = [
      { type: "remote-create", path: 2 },
      { type: "pull" },
      { type: "user-rename", file: 0, mode: "pool", target: 0 },
      { type: "remote-delete", document: 0 },
      { type: "move-onto-incoming", file: 0, path: 2 },
    ];
    const world = new PropertyWorld("posix");
    for (const command of steps) await world.apply(command);
    await world.quiesce();
    expect(await world.vault.list()).toEqual(["b.md"]);
    expect([...world.server.liveFiles().keys()]).toEqual(["b.md"]);
    expect(world.errors).toEqual([]);
  });
});
