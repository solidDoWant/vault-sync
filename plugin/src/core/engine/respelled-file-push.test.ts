import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// A note whose file the vault holds under another spelling than the journal's
// path, with no rename event to say so (the user's rename was lost to a
// restart, or the user moved the note away and saved a new file under another
// spelling of its path): the push takes the file for the note's, and commits
// it under the spelling the vault holds, so the vault and the server name the
// note alike (#481, SPEC.md §8). Committed under the journal's spelling, the
// server would keep a path the vault does not hold, for good.

const bytes = (value: string) => new TextEncoder().encode(value);

const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe.each(["windows", "macos"] as const)("a note's file respelled behind the engine's back on %s (#481)", (platform) => {
  it.each([
    ["by case", "a.md", "A.md"],
    ["by ß/SS", "straße.md", "STRASSE.md"],
  ])("commits a rename %s lost to a restart under the vault's spelling", async (_how, synced, respelled) => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: synced, content: "note\n" });
    await h.engine.pull();

    await h.vault.rename(synced, respelled);
    h.restart();
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([[respelled, "note"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it.each([
    ["by case", "a.md", "A.md"],
    ["by ß/SS", "straße.md", "STRASSE.md"],
  ])("commits an edit of a file renamed %s before a restart under the vault's spelling", async (_how, synced, respelled) => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: synced, content: "note\n" });
    await h.engine.pull();

    await h.vault.rename(synced, respelled);
    await h.vault.write(respelled, bytes("note\nedited\n"));
    h.restart();
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([[respelled, "note"]]));
    expect(h.server.liveFiles()).toEqual(new Map([[respelled, "note\nedited\n"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it("names the note as the vault does when the user moved it away and saved a new file under another spelling of its path before a restart (seed 100083)", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "STRASSE.md", content: "note\n" });
    h.server.commit({ documentId: "other", path: "d.md", content: "other\n" });
    await h.engine.pull();

    // The user deletes d.md, moves the note there and saves a new file
    // straße.md; the app is killed before the engine records any of it.
    await h.vault.delete("d.md");
    await h.vault.rename("STRASSE.md", "d.md");
    await h.vault.write("straße.md", bytes("new\n"));
    h.restart();
    await h.engine.push();

    // Nothing is lost, and every file the vault holds is a live document
    // under the spelling the vault holds it.
    expect(await files(h.vault)).toEqual(new Map([["d.md", "note\n"], ["straße.md", "new\n"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it("keeps the server's spelling when a remote respelling arrives for a note the vault holds under the synced one", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "straße.md", content: "note\n" });
    await h.engine.pull();

    h.server.commit({ documentId: "note", path: "STRASSE.md", content: "note\n" });
    await h.engine.pull();
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["STRASSE.md", "note"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });
});
