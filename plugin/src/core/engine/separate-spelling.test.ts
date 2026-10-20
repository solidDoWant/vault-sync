import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { copyOf, files, harness, type Harness } from "./testing";

// Two spellings with one path key (SPEC.md §5) can be two files on the
// device: NTFS folds neither `ß`/`SS` nor NFC/NFD, and APFS does not fold
// `ß`/`SS`. On-device identity follows the filesystem (decision #52): a new
// file next to a synced note whose spelling merely has the note's path key
// is a new file, which the server refuses at that key and which is kept as a
// conflict copy, never dropped from sync (#399). The vault here keeps every
// spelling apart, as those filesystems do (#396 covers the simulation).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const nfc = (value: string) => value.normalize("NFC");
const nfd = (value: string) => value.normalize("NFD");

const separateFiles = [
  { platform: "windows", note: "Straße.md", other: "STRASSE.md", copy: copyOf("STRASSE", ".md") },
  { platform: "windows", note: nfc("Café.md"), other: nfd("Café.md"), copy: copyOf(nfd("Café"), ".md") },
  { platform: "macos", note: "Straße.md", other: "STRASSE.md", copy: copyOf("STRASSE", ".md") },
] as const;

function exactVault(platform: "macos" | "windows"): Harness {
  return harness({ merge: "default", pathRules: { platform }, vault: new InMemoryVault() });
}

async function pushRounds(h: Harness): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await h.engine.push();
    await h.engine.settled();
  }
}

describe.each(separateFiles)("a new file $other next to the synced note $note on $platform (#399)", ({ platform, note, other, copy }) => {
  it("reaches the server as a conflict copy and the vault converges", async () => {
    const h = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "x\n" });
    await h.engine.pull();
    await h.vault.write(other, bytes("new\n"));
    await h.engine.settled();

    await pushRounds(h);
    await h.restart().pull();
    await pushRounds(h);

    expect(h.server.liveFiles()).toEqual(
      new Map([
        [note, "x\n"],
        [copy, "new\n"],
      ]),
    );
    expect(h.server.liveDocuments().get(note)).toBe("note");
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.listDeferred()).toEqual([]);
  });

  it("leaves the note alone when the user deletes the new file before a push", async () => {
    const h = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "x\n" });
    await h.engine.pull();
    await h.vault.write(other, bytes("new\n"));
    await h.engine.settled();
    await h.vault.delete(other);
    await h.engine.settled();

    await pushRounds(h);

    expect(h.server.liveDocuments()).toEqual(new Map([[note, "note"]]));
    expect(h.server.liveFiles()).toEqual(new Map([[note, "x\n"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  it("pushes the user's edit of the note as its edit when the user deletes the new file before a push", async () => {
    const h = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "x\n" });
    await h.engine.pull();
    await h.vault.write(note, bytes("edited\n"));
    await h.vault.write(other, bytes("new\n"));
    await h.engine.settled();
    await h.vault.delete(other);
    await h.engine.settled();

    await pushRounds(h);

    expect(h.server.liveDocuments()).toEqual(new Map([[note, "note"]]));
    expect(h.server.history("note")).toHaveLength(2);
    expect(h.server.liveFiles()).toEqual(new Map([[note, "edited\n"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  it("pushes the new file as a create, never a rename of the note, when the user renames it before a push", async () => {
    const h = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "x\n" });
    await h.engine.pull();
    await h.vault.write(other, bytes("new\n"));
    await h.engine.settled();
    await h.vault.rename(other, "moved.md");
    await h.engine.settled();

    await pushRounds(h);

    expect(h.server.liveDocuments().get(note)).toBe("note");
    expect(h.server.liveFiles()).toEqual(
      new Map([
        [note, "x\n"],
        ["moved.md", "new\n"],
      ]),
    );
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  it("pushes the note's rename as its rename after the user renamed the new file away", async () => {
    const h = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "x\n" });
    await h.engine.pull();
    await h.vault.write(other, bytes("new\n"));
    await h.engine.settled();
    await h.vault.rename(other, "moved.md");
    await h.vault.rename(note, "renamed.md");
    await h.engine.settled();

    await pushRounds(h);

    expect(h.server.liveDocuments().get("renamed.md")).toBe("note");
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["renamed.md", "x\n"],
        ["moved.md", "new\n"],
      ]),
    );
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  it("keeps the note's id for its rename after a failed push and a rename of the new file away", async () => {
    const h = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "x\n" });
    await h.engine.pull();
    await h.vault.write(note, bytes("edited\n"));
    await h.vault.write(other, bytes("new\n"));
    await h.engine.settled();
    // The push fails, leaving the note's edit pending at its spelling.
    h.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new Error("offline");
    };
    await expect(h.engine.push()).rejects.toThrow();
    await h.engine.settled();
    expect((await h.journal.listPending()).map((operation) => operation.path)).toContain(note);
    await h.vault.rename(other, "moved.md");
    await h.vault.rename(note, "renamed.md");
    await h.engine.settled();
    h.server.interceptor = undefined;

    await pushRounds(h);

    expect(h.server.liveDocuments().get("renamed.md")).toBe("note");
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["renamed.md", "edited\n"],
        ["moved.md", "new\n"],
      ]),
    );
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  it("keeps the note's id for its rename after a failed push of the new file and its rename away", async () => {
    const h = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "x\n" });
    await h.engine.pull();
    await h.vault.write(other, bytes("new\n"));
    await h.engine.settled();
    // The push fails, leaving the new file's create pending at its spelling.
    h.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new Error("offline");
    };
    await expect(h.engine.push()).rejects.toThrow();
    await h.engine.settled();
    h.server.interceptor = undefined;
    await h.vault.rename(other, "moved.md");
    await h.vault.rename(note, "renamed.md");
    await h.engine.settled();

    await pushRounds(h);

    expect(h.server.liveDocuments().get("renamed.md")).toBe("note");
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["renamed.md", "x\n"],
        ["moved.md", "new\n"],
      ]),
    );
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  it("pushes an edit of the note while the other file stands next to it", async () => {
    const h = exactVault(platform);
    h.server.commit({ documentId: "note", path: note, content: "x\n" });
    await h.engine.pull();
    await h.vault.write(other, bytes("new\n"));
    await h.vault.write(note, bytes("edited\n"));
    await h.engine.settled();

    await pushRounds(h);

    expect(h.server.liveDocuments().get(note)).toBe("note");
    expect(h.server.liveFiles()).toEqual(
      new Map([
        [note, "edited\n"],
        [copy, "new\n"],
      ]),
    );
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });
});
