import { describe, expect, it } from "vitest";

import { PathSpace } from "./pathspace";

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
      expect(space.serverKey("ı.md")).toBe("i.md");
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

        it("joins the dotless ı and I, which share a path key (the NTFS upcase mapping, engine.md §6) and one filesystem name", () => {
          expect(space.serverKey("ı.md")).toBe(space.serverKey("I.md"));
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

  describe("nesting under F (#843, #854)", () => {
    // [a, b, nested on posix, nested on windows, nested on macos]: whether one is a folder of the other.
    const cases: { name: string; a: string; b: string; nested: Record<"posix" | "windows" | "macos", boolean> }[] = [
      { name: "a file in a folder at the other", a: "notes/a.md", b: "notes", nested: { posix: true, windows: true, macos: true } },
      { name: "a file in a folder of another case", a: "notes/a.md", b: "NOTES", nested: { posix: false, windows: true, macos: true } },
      { name: "a file deep in a folder of another case", a: "Notes/sub/a.md", b: "NOTES/SUB", nested: { posix: false, windows: true, macos: true } },
      { name: "a file in a folder of another form", a: `${nfc("Café")}/a.md`, b: nfd("CAFÉ"), nested: { posix: false, windows: false, macos: true } },
      { name: "one spelling", a: "notes", b: "notes", nested: { posix: false, windows: false, macos: false } },
      { name: "case variants of one name", a: "notes", b: "NOTES", nested: { posix: false, windows: false, macos: false } },
      { name: "a shared folder only", a: "notes/a.md", b: "notes/b.md", nested: { posix: false, windows: false, macos: false } },
      { name: "a name prefix that is no folder", a: "notes2/a.md", b: "notes", nested: { posix: false, windows: false, macos: false } },
    ];
    const spaces = { posix, windows, macos };
    for (const { name, a, b, nested } of cases) {
      it(`${name}: ${String(nested.posix)} on posix, ${String(nested.windows)} on windows, ${String(nested.macos)} on macos`, () => {
        for (const [platform, space] of Object.entries(spaces) as ["posix" | "windows" | "macos", PathSpace][]) {
          // Both directions: a file in a folder at the other's path, and a file where the other needs a folder.
          expect(space.nested(a, b), `${platform}: ${a} in ${b}`).toBe(nested[platform]);
          expect(space.nested(b, a), `${platform}: ${b} over ${a}`).toBe(nested[platform]);
          expect(space.nestedIn([a])(b), `${platform}: index of ${a}, looking up ${b}`).toBe(nested[platform]);
          expect(space.nestedIn([b])(a), `${platform}: index of ${b}, looking up ${a}`).toBe(nested[platform]);
        }
      });
    }

    it("finds a path nested with any of several paths, and none in an empty list", () => {
      const nestedWithAny = macos.nestedIn(["x.md", "NOTES", "Other/deep/c.md"]);
      expect(nestedWithAny("notes/a.md")).toBe(true);
      expect(nestedWithAny("OTHER")).toBe(true);
      expect(nestedWithAny("other/DEEP")).toBe(true);
      expect(nestedWithAny("notes")).toBe(false);
      expect(nestedWithAny("x.md")).toBe(false);
      expect(nestedWithAny("Other/deep/c.md")).toBe(false);
      expect(macos.nestedIn([])("notes/a.md")).toBe(false);
    });
  });

  describe("collisions", () => {
    const cases: { name: string; a: string; b: string; server: boolean; file: Record<"posix" | "windows", boolean> }[] = [
      { name: "one spelling", a: "a.md", b: "a.md", server: true, file: { posix: true, windows: true } },
      { name: "case variants", a: "Notes/A.md", b: "notes/a.md", server: true, file: { posix: false, windows: true } },
      { name: "a file and a folder of the other", a: "Notes", b: "notes/a.md", server: true, file: { posix: false, windows: true } },
      { name: "a folder of the other and a file", a: "notes/a.md", b: "NOTES", server: true, file: { posix: false, windows: true } },
      { name: "a shared folder only", a: "notes/a.md", b: "notes/b.md", server: false, file: { posix: false, windows: false } },
      { name: "a name prefix that is no folder", a: "notes", b: "notes2/a.md", server: false, file: { posix: false, windows: false } },
      { name: "ı and I", a: "ı.md", b: "I.md", server: true, file: { posix: false, windows: true } },
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
