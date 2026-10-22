import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { files, harness, InterleavingVault, type Harness } from "./testing";

// On a case-insensitive platform the vault reports a change under the
// spelling the file has on disk, which can differ from the document's path
// in the journal: the user deleted `strasse.md` and saved the note again as
// `STRASSE.md`, one file on NTFS and APFS (#396). (Seed 1006 respelled it by
// `ß`/`SS`, which those filesystems keep as two files, #797.) The engine's own
// change of that file is still its own, and never reported as the user's
// (SPEC.md §8, #380).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

describe.each(["macos", "windows"] as const)("engine changes of a file the user re-saved under another spelling on %s (#380)", (platform) => {
  it("reports only the user's changes when a remote rename of the note the user is editing is applied", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "strasse.md", content: "a\nb\nc\n" });
    await h.engine.pull();

    await h.vault.delete("strasse.md");
    await h.vault.write("STRASSE.md", bytes("a\nb\nc\nlocal\n"));
    h.server.commit({ documentId: "note", path: "e.md", content: "remote\na\nb\nc\n" });
    await h.engine.pull();
    await h.engine.settled();
    await h.vault.write("e.md", bytes("remote\na\nb\nc\nlocal\nmore\n"));
    await h.engine.settled();

    expect(await files(h.vault)).toEqual(new Map([["e.md", "remote\na\nb\nc\nlocal\nmore\n"]]));
    expect(h.localChanges).toEqual([
      { type: "delete", path: "strasse.md" },
      { type: "create", path: "STRASSE.md" },
      { type: "modify", path: "e.md" },
    ]);

    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["e.md", "note"]]));
    expect(h.server.liveFiles()).toEqual(await files(h.vault));
  });

  it("reports only the user's changes when a clean remote rename of the note is applied", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "strasse.md", content: "a\n" });
    await h.engine.pull();

    await h.vault.delete("strasse.md");
    await h.vault.write("STRASSE.md", bytes("a\n"));
    h.server.commit({ documentId: "note", path: "e.md" });
    await h.engine.pull();
    await h.engine.settled();

    expect(await files(h.vault)).toEqual(new Map([["e.md", "a\n"]]));
    expect(h.localChanges).toEqual([
      { type: "delete", path: "strasse.md" },
      { type: "create", path: "STRASSE.md" },
    ]);
  });

  it("reports only the user's changes when a remote delete of the note is applied", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "strasse.md", content: "a\n" });
    await h.engine.pull();

    await h.vault.delete("strasse.md");
    await h.vault.write("STRASSE.md", bytes("a\n"));
    h.server.commit({ documentId: "note", path: "strasse.md", deleted: true });
    await h.engine.pull();
    await h.engine.settled();

    expect(await files(h.vault)).toEqual(new Map());
    expect(h.localChanges).toEqual([
      { type: "delete", path: "strasse.md" },
      { type: "create", path: "STRASSE.md" },
    ]);
  });
});

// Two spellings with the same path key can be two files on the device: NTFS
// folds neither `ß`/`SS` nor NFC/NFD, and APFS does not fold `ß`/`SS`. A
// user's change of the other file, landing just before the engine's own
// change, is the user's and is reported; the engine's change is not
// (SPEC.md §8, #380). The vault here keeps every spelling apart.
const nfc = (value: string) => value.normalize("NFC");
const nfd = (value: string) => value.normalize("NFD");
const separateFiles = [
  { platform: "windows", note: "Straße.md", other: "STRASSE.md", renamed: "Maß.md", otherRenamed: "MASS.md" },
  { platform: "windows", note: nfc("Café.md"), other: nfd("Café.md"), renamed: nfc("Résumé.md"), otherRenamed: nfd("Résumé.md") },
  { platform: "macos", note: "Straße.md", other: "STRASSE.md", renamed: "Maß.md", otherRenamed: "MASS.md" },
] as const;

function exactVault(platform: "macos" | "windows"): { h: Harness; vault: InterleavingVault } {
  let vault: InterleavingVault | undefined;
  const h = harness({
    merge: "default",
    pathRules: { platform },
    vault: new InMemoryVault(),
    wrapVault: (inner) => {
      vault = new InterleavingVault(inner);
      return vault;
    },
  });
  if (vault === undefined) throw new Error("the harness did not wrap the vault");
  return { h, vault };
}

describe.each(separateFiles)("a user change of $other next to the engine's change of $note on $platform (#380)", ({ platform, note, other, renamed, otherRenamed }) => {
  it("reports the user's delete and not the engine's", async () => {
    const { h, vault } = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "a\n" });
    await h.engine.pull();
    await h.vault.write(other, bytes("b\n"));
    h.server.commit({ documentId: "note", path: note, deleted: true });
    vault.beforeNextChange(note, () => h.vault.delete(other));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(await files(h.vault)).toEqual(new Map());
    expect(h.localChanges).toEqual([
      { type: "create", path: other },
      { type: "delete", path: other },
    ]);
  });

  it("reports the user's rename and not the engine's", async () => {
    const { h, vault } = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "a\n" });
    await h.engine.pull();
    await h.vault.write(other, bytes("b\n"));
    h.server.commit({ documentId: "note", path: renamed });
    vault.beforeNextChange(note, () => h.vault.rename(other, otherRenamed));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(await files(h.vault)).toEqual(
      new Map([
        [renamed, "a\n"],
        [otherRenamed, "b\n"],
      ]),
    );
    expect(h.localChanges).toEqual([
      { type: "create", path: other },
      { type: "rename", path: otherRenamed, oldPath: other },
    ]);
  });

  it("reports the user's create of the content the engine writes, and not the engine's write", async () => {
    const { h, vault } = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "a\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "note", path: note, content: "c\n" });
    vault.beforeNextChange(note, () => h.vault.write(other, bytes("c\n")));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(await files(h.vault)).toEqual(
      new Map([
        [note, "c\n"],
        [other, "c\n"],
      ]),
    );
    expect(h.localChanges).toEqual([{ type: "create", path: other }]);
  });
});

describe.each(["macos", "windows"] as const)("an engine write to a note whose file the user respelled on %s (#380)", (platform) => {
  it("is not reported as a local change", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "a.md", content: "a\nb\nc\n" });
    await h.engine.pull();
    await h.vault.rename("a.md", "A.md");
    await h.engine.settled();
    h.server.commit({ documentId: "note", path: "a.md", content: "remote\na\nb\nc\n" });

    await h.engine.pull();
    await h.engine.settled();

    expect(await files(h.vault)).toEqual(new Map([["A.md", "remote\na\nb\nc\n"]]));
    expect(h.localChanges).toEqual([{ type: "rename", path: "A.md", oldPath: "a.md" }]);
  });
});
