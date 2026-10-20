import { describe, expect, it } from "vitest";

import { files, syncedOnBoth, twoDevices } from "./testing";

// The user renames a synced note onto a path P and edits it without pushing,
// while another device creates a different note at P (#479). In the
// `remote-delete` variant, the other device first deletes the renamed note,
// and in `remote-rename` it also brings the other note to P by renaming it
// there rather than creating it. The pull keeps the user's file apart from
// the other note, and a later rename of the file at P is the other note's. No push tombstones the other device's
// note, the user's edit stays live, and both devices converge (SPEC.md §2
// principle 1).

const bytes = (content: string) => new TextEncoder().encode(content);
const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe.each(["posix", "macos", "windows"] as const)("an unpushed rename onto the path of a remote create on %s (#479)", (platform) => {
  it.each(["remote-create", "remote-delete", "remote-rename"] as const)("never tombstones the other device's note (%s)", async (variant) => {
    const devices = twoDevices({ pathRules: { platform } });
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "b.md", "b\n");
    if (variant === "remote-rename") await syncedOnBoth(devices, "y.md", "theirs\n");
    const renamed = server.liveDocuments().get("b.md");
    expect(renamed).toBeDefined();

    await a.vault.rename("b.md", "NOTES");
    await a.vault.write("NOTES", bytes("b\nmine\n"));
    await a.engine.settled();
    if (variant !== "remote-create") await b.vault.delete("b.md");
    if (variant === "remote-rename") await b.vault.rename("y.md", "NOTES");
    else await b.vault.write("NOTES", bytes("theirs\n"));
    await b.engine.push();
    const theirs = server.liveDocuments().get("NOTES");
    expect(theirs).toBeDefined();
    expect(theirs).not.toBe(renamed);

    await a.engine.pull();
    // The user renames whatever file is at NOTES now.
    await a.vault.rename("NOTES", "x.md");
    await a.engine.settled();
    for (let round = 0; round < 4; round++) {
      await a.engine.push();
      await b.engine.push();
    }
    await a.engine.pull();
    await b.engine.pull();

    expect(server.head(theirs ?? "")?.deleted).toBe(false);
    expect([...server.liveFiles().values()]).toContain("b\nmine\n");
    expect([...server.liveFiles().values()]).toContain("theirs\n");
    expect(new Set(server.liveDocuments().values()).has(theirs ?? "")).toBe(true);
    expect(await files(a.vault)).toEqual(server.liveFiles());
    expect(await files(b.vault)).toEqual(server.liveFiles());
    expect(await a.journal.listDeferred()).toEqual([]);
    expect(await b.journal.listDeferred()).toEqual([]);
    expect(await a.engine.push()).toEqual(quiet);
    expect(await b.engine.push()).toEqual(quiet);
  });
});
