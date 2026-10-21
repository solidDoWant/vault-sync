import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { deferredDocuments } from "./deferred";
import { PathSpace } from "./pathspace";
import { files, harness } from "./testing";

const nfc = (value: string) => value.normalize("NFC");
const nfd = (value: string) => value.normalize("NFD");

describe("PathSpace", () => {
  // Expected keys are spelled out, never computed with pathKey or filesystemKey.
  const windows = new PathSpace({ platform: "windows" });
  const macos = new PathSpace({ platform: "macos" });
  const posix = new PathSpace({ platform: "posix" });

  it("keys paths for the server by path key on every platform", () => {
    for (const space of [windows, macos, posix]) {
      expect(space.serverKey("Notes/Straße.md")).toBe("notes/strasse.md");
      expect(space.serverKey("ı.md")).toBe("ı.md");
      expect(space.serverKey(nfd("Café.md"))).toBe(nfc("café.md"));
    }
  });

  it("keys paths by filesystem name: identity on posix, upper case on windows, NFD and upper case on macos", () => {
    expect(posix.filesystemKey("Notes/ı.md")).toBe("Notes/ı.md");
    expect(windows.filesystemKey("Notes/ı.md")).toBe("NOTES/I.MD");
    expect(windows.filesystemKey("Straße.md")).toBe("STRAßE.MD");
    expect(windows.filesystemKey(nfc("Café.md"))).toBe(nfc("CAFÉ.MD"));
    expect(macos.filesystemKey(nfc("Café.md"))).toBe(nfd("CAFÉ.MD"));
  });

  describe("file key", () => {
    it("is the path itself on posix", () => {
      expect(posix.fileKey("Notes/A.md")).toBe("Notes/A.md");
      expect(posix.fileKey("ı.md")).not.toBe(posix.fileKey("I.md"));
    });

    for (const space of [windows, macos]) {
      describe(`on ${space.rules.platform}`, () => {
        it("joins spellings with one path key", () => {
          expect(space.fileKey("Notes/Straße.md")).toBe("notes/strasse.md");
          expect(space.fileKey("NOTES/STRASSE.md")).toBe("notes/strasse.md");
          expect(space.fileKey(nfd("Café.md"))).toBe(space.fileKey(nfc("Café.md")));
        });

        it("joins the dotless ı and I, which the filesystem takes for one name although their path keys differ (§6.4 item 4)", () => {
          expect(space.serverKey("ı.md")).not.toBe(space.serverKey("I.md"));
          expect(space.oneFile("ı.md", "I.md")).toBe(true);
          expect(space.fileKey("ı.md")).toBe("i.md");
          expect(space.fileKey("I.md")).toBe("i.md");
          expect(space.fileKey("notes/ı/a.md")).toBe(space.fileKey("Notes/I/A.md"));
        });

        it("keeps apart names that differ by more than case and form", () => {
          expect(space.fileKey("a.md")).not.toBe(space.fileKey("b.md"));
          expect(space.fileKey("i.md")).not.toBe(space.fileKey("j.md"));
        });
      });
    }
  });

  describe("on Android's shared storage (decision 7, #544)", () => {
    const android = new PathSpace({ platform: "android" });

    it("keys paths by filesystem name as FAT and sdcardfs fold it: simple upper case per UTF-16 unit, no normalization", () => {
      expect(android.filesystemKey("Notes/a.md")).toBe("NOTES/A.MD");
      expect(android.filesystemKey("Notes/ı.md")).toBe("NOTES/I.MD");
      expect(android.filesystemKey("Straße.md")).toBe("STRAßE.MD");
      expect(android.filesystemKey(nfc("Café.md"))).toBe(nfc("CAFÉ.MD"));
      expect(android.filesystemKey(nfd("Café.md"))).toBe(nfd("CAFÉ.MD"));
    });

    it("takes every case spelling of a name for one file, and the next spelling that differs by more than case for another", () => {
      // N spellings, one file.
      const oneFile = ["notes/a.md", "Notes/A.md", "NOTES/a.MD", "notes/A.md"];
      for (const spelling of oneFile) {
        for (const other of oneFile) expect(android.oneFile(spelling, other)).toBe(true);
        expect(android.fileKey(spelling)).toBe("notes/a.md");
        expect(android.collides(spelling, "notes/a.md", "file")).toBe(true);
      }
      expect(android.oneFile("ı.md", "I.md")).toBe(true);
      expect(android.oneFile("i.md", "I.md")).toBe(true);
      // The N+1th spelling: another name, or one only a fold the filesystem does not do makes equal.
      for (const other of ["notes/b.md", "notes/á.md", "notes/a.md.md", "notes/a"]) expect(android.oneFile("Notes/A.md", other)).toBe(false);
      expect(android.oneFile("Straße.md", "STRASSE.md")).toBe(false);
      expect(android.oneFile(nfc("Café.md"), nfd("Café.md"))).toBe(false);
    });

    it("is not the posix identity any more", () => {
      expect(posix.oneFile("notes/a.md", "Notes/A.md")).toBe(false);
      expect(android.oneFile("notes/a.md", "Notes/A.md")).toBe(true);
    });
  });

  describe("U+0345 COMBINING GREEK YPOGEGRAMMENI (#585)", () => {
    // α U+0345 U+0301 is not in canonical order (U+0345 has combining class
    // 240, U+0301 230); α U+0301 U+0345 and ᾴ (U+1FB4) are its canonical
    // equivalents. α ι U+0301 differs from it once case folding turns U+0345
    // into ι: after canonical reordering it is άι, not αί.
    const unordered = "\u03b1\u0345\u0301.md";
    const ordered = "\u03b1\u0301\u0345.md";
    const precomposed = "\u1fb4.md";
    const iota = "\u03b1\u03b9\u0301.md";

    for (const space of [windows, new PathSpace({ platform: "android" })]) {
      describe(`on ${space.rules.platform}, which upper-cases without normalizing`, () => {
        it("gives canonically equivalent spellings one path key but, where upper case pins U+0345's place, two file keys", () => {
          expect(space.serverKey(unordered)).toBe("\u03ac\u03b9.md");
          expect(space.serverKey(ordered)).toBe("\u03ac\u03b9.md");
          expect(space.serverKey(precomposed)).toBe("\u03ac\u03b9.md");
          expect(space.fileKey(unordered)).toBe("\u03b1\u03af.md");
          expect(space.fileKey(ordered)).toBe("\u03ac\u03b9.md");
          expect(space.fileKey(precomposed)).toBe("\u03ac\u03b9.md");
          expect(space.oneFile(unordered, ordered)).toBe(false);
        });

        it("gives one file key to spellings with one filesystem key and two path keys", () => {
          expect(space.filesystemKey(unordered)).toBe("\u0391\u0399\u0301.MD");
          expect(space.filesystemKey(iota)).toBe("\u0391\u0399\u0301.MD");
          expect(space.oneFile(unordered, iota)).toBe(true);
          expect(space.serverKey(unordered)).not.toBe(space.serverKey(iota));
          expect(space.fileKey(unordered)).toBe(space.fileKey(iota));
          expect(space.collides(unordered, iota, "file")).toBe(true);
          expect(space.collides(unordered, iota, "server")).toBe(false);
        });
      });
    }

    it("keeps every canonical order one file on macos, which decomposes before upper-casing", () => {
      expect(macos.oneFile(unordered, ordered)).toBe(true);
      expect(macos.oneFile(unordered, precomposed)).toBe(true);
      expect(macos.fileKey(unordered)).toBe("\u03ac\u03b9.md");
      expect(macos.fileKey(ordered)).toBe("\u03ac\u03b9.md");
      expect(macos.oneFile(unordered, iota)).toBe(false);
    });
  });

  it("tells one file from two files with one file key", () => {
    expect(windows.oneFile("Straße.md", "STRASSE.md")).toBe(false);
    expect(windows.fileKey("Straße.md")).toBe(windows.fileKey("STRASSE.md"));
    expect(windows.oneFile("Notes/a.md", "NOTES/A.md")).toBe(true);
    expect(windows.oneFile(nfc("Café.md"), nfd("Café.md"))).toBe(false);
    expect(macos.oneFile(nfc("Café.md"), nfd("Café.md"))).toBe(true);
    expect(posix.oneFile("a.md", "A.md")).toBe(false);
    expect(posix.oneFile("a.md", "a.md")).toBe(true);
  });

  it("tells paths spelled alike but for folders one file takes for one from other spellings (#737)", () => {
    expect(windows.sameButFolderSpelling("notes/a.md", "Notes/a.md")).toBe(true);
    expect(windows.sameButFolderSpelling("NOTES/sub/a.md", "notes/Sub/a.md")).toBe(true);
    expect(windows.sameButFolderSpelling("a.md", "a.md")).toBe(true);
    // The final segment compares exactly: a case-only rename of the file is a respelling.
    expect(windows.sameButFolderSpelling("a.md", "A.md")).toBe(false);
    expect(windows.sameButFolderSpelling("notes/a.md", "Notes/A.md")).toBe(false);
    expect(windows.sameButFolderSpelling("xa.md", "ya.md")).toBe(false);
    // Folders compare under F, not K: Straße/ and STRASSE/ are two folders.
    expect(windows.sameButFolderSpelling("Straße/a.md", "STRASSE/a.md")).toBe(false);
    expect(windows.sameButFolderSpelling("a.md", "x/a.md")).toBe(false);
    expect(macos.sameButFolderSpelling(`${nfc("Café")}/a.md`, `${nfd("CAFÉ")}/a.md`)).toBe(true);
    expect(posix.sameButFolderSpelling("notes/a.md", "Notes/a.md")).toBe(false);
  });

  it("lists a path's folders outermost first", () => {
    expect(posix.ancestors("a.md")).toEqual([]);
    expect(posix.ancestors("a/b/c.md")).toEqual(["a", "a/b"]);
  });

  describe("collisions", () => {
    const cases: { name: string; a: string; b: string; server: boolean; file: Record<"posix" | "windows", boolean> }[] = [
      { name: "one spelling", a: "a.md", b: "a.md", server: true, file: { posix: true, windows: true } },
      { name: "case variants", a: "Notes/A.md", b: "notes/a.md", server: true, file: { posix: false, windows: true } },
      { name: "a file and a folder of the other", a: "Notes", b: "notes/a.md", server: true, file: { posix: false, windows: true } },
      { name: "a folder of the other and a file", a: "notes/a.md", b: "NOTES", server: true, file: { posix: false, windows: true } },
      { name: "a shared folder only", a: "notes/a.md", b: "notes/b.md", server: false, file: { posix: false, windows: false } },
      { name: "a name prefix that is no folder", a: "notes", b: "notes2/a.md", server: false, file: { posix: false, windows: false } },
      { name: "ı and I", a: "ı.md", b: "I.md", server: false, file: { posix: false, windows: true } },
    ];
    for (const { name, a, b, server, file } of cases) {
      it(`${name}: server ${String(server)}, file ${String(file.posix)} on posix and ${String(file.windows)} on windows`, () => {
        for (const [x, y] of [
          [a, b],
          [b, a],
        ] as const) {
          expect(posix.collides(x, y, "server")).toBe(server);
          expect(windows.collides(x, y, "server")).toBe(server);
          expect(posix.collides(x, y, "file")).toBe(file.posix);
          expect(windows.collides(x, y, "file")).toBe(file.windows);
        }
      });
    }
  });
});

describe.each(["windows", "macos", "android"] as const)("documents at ı.md and I.md on %s, one file on the device (§6.4 item 4)", (platform) => {
  it("never writes the second document over the first document's file", async () => {
    const h = harness({ merge: "default", pathRules: { platform }, vault: new InMemoryVault({ pathRules: { platform } }) });
    h.server.commit({ documentId: "dotless", path: "ı.md", content: "dotless\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "capital", path: "I.md", content: "capital\n" });
    await h.engine.pull();
    for (let round = 0; round < 3; round++) {
      await h.engine.push();
      await h.engine.settled();
      await h.engine.pull();
    }

    // The server's documents keep their own content: neither became the other's.
    expect(h.server.liveDocuments().get("ı.md")).toBe("dotless");
    expect(h.server.liveFiles().get("ı.md")).toBe("dotless\n");
    expect(h.server.liveFiles().get("I.md")).toBe("capital\n");
    // The device's one file at that name is still the first document's.
    expect(await files(h.vault)).toEqual(new Map([["ı.md", "dotless\n"]]));
    expect(text(await h.vault.read("I.md"))).toBe("dotless\n");
    // The device can hold only one of the two (decision #52, #736): the second is unmaterializable
    // here (`alias`), a non-disk blocker listed for the user (#585 item 2), never a path conflict
    // that waits for good or a hidden local change.
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason, deferred.unmaterializable])).toEqual([["capital", "unmaterializable", "alias"]]);
    expect((await h.engine.unmaterializable()).map((document) => [document.documentId, document.reason])).toEqual([["capital", "alias"]]);
    expect(await deferredDocuments(h.journal, h.vault)).toEqual([]);
  });
});

function text(content: Uint8Array): string {
  return new TextDecoder().decode(content);
}

