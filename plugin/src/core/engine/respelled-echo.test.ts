import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// On a case-insensitive platform the vault reports a change under the
// spelling the file has on disk, which can differ from the document's path
// in the journal: the user deleted `straße.md` and saved the note again as
// `STRASSE.md`. The engine's own change of that file is still its own, and
// never reported as the user's (SPEC.md §8, #380).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

describe.each(["macos", "windows"] as const)("engine changes of a file the user re-saved under another spelling on %s (#380)", (platform) => {
  it("reports only the user's changes when a remote rename of the note the user is editing is applied", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "straße.md", content: "a\nb\nc\n" });
    await h.engine.pull();

    await h.vault.delete("straße.md");
    await h.vault.write("STRASSE.md", bytes("a\nb\nc\nlocal\n"));
    h.server.commit({ documentId: "note", path: "e.md", content: "remote\na\nb\nc\n" });
    await h.engine.pull();
    await h.engine.settled();
    await h.vault.write("e.md", bytes("remote\na\nb\nc\nlocal\nmore\n"));
    await h.engine.settled();

    expect(await files(h.vault)).toEqual(new Map([["e.md", "remote\na\nb\nc\nlocal\nmore\n"]]));
    expect(h.localChanges).toEqual([
      { type: "delete", path: "straße.md" },
      { type: "create", path: "STRASSE.md" },
      { type: "modify", path: "e.md" },
    ]);

    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["e.md", "note"]]));
    expect(h.server.liveFiles()).toEqual(await files(h.vault));
  });

  it("reports only the user's changes when a clean remote rename of the note is applied", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "straße.md", content: "a\n" });
    await h.engine.pull();

    await h.vault.delete("straße.md");
    await h.vault.write("STRASSE.md", bytes("a\n"));
    h.server.commit({ documentId: "note", path: "e.md" });
    await h.engine.pull();
    await h.engine.settled();

    expect(await files(h.vault)).toEqual(new Map([["e.md", "a\n"]]));
    expect(h.localChanges).toEqual([
      { type: "delete", path: "straße.md" },
      { type: "create", path: "STRASSE.md" },
    ]);
  });

  it("reports only the user's changes when a remote delete of the note is applied", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "straße.md", content: "a\n" });
    await h.engine.pull();

    await h.vault.delete("straße.md");
    await h.vault.write("STRASSE.md", bytes("a\n"));
    h.server.commit({ documentId: "note", path: "straße.md", deleted: true });
    await h.engine.pull();
    await h.engine.settled();

    expect(await files(h.vault)).toEqual(new Map());
    expect(h.localChanges).toEqual([
      { type: "delete", path: "straße.md" },
      { type: "create", path: "STRASSE.md" },
    ]);
  });
});
