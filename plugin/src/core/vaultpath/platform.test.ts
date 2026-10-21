import { describe, expect, it } from "vitest";

import { filesystemKey, unmaterializableReason, type PathPlatform, type UnmaterializableReason } from "./platform";

const repeat = (text: string, count: number) => text.repeat(count);

describe("unmaterializableReason", () => {
  const cases: { name: string; path: string; expected: Partial<Record<PathPlatform, UnmaterializableReason>> }[] = [
    { name: "an ordinary note", path: "notes/daily.md", expected: {} },
    { name: "a dot file", path: ".obsidian/app.json", expected: {} },
    { name: "a name with dots and spaces inside", path: "a b. c.md", expected: {} },
    { name: "a reserved device name with an extension", path: "CON.md", expected: { windows: "reserved-name" } },
    { name: "a reserved device name in lower case", path: "notes/con.md", expected: { windows: "reserved-name" } },
    { name: "a reserved device name without an extension", path: "NUL", expected: { windows: "reserved-name" } },
    { name: "a reserved device name with two extensions", path: "nul.tar.gz", expected: { windows: "reserved-name" } },
    { name: "a reserved device name before spaces and an extension", path: "AUX .md", expected: { windows: "reserved-name" } },
    { name: "a reserved device name as a folder", path: "prn/a.md", expected: { windows: "reserved-name" } },
    { name: "a numbered serial port", path: "COM1.txt", expected: { windows: "reserved-name" } },
    { name: "serial port zero", path: "com0", expected: { windows: "reserved-name" } },
    { name: "a numbered parallel port", path: "LPT9.md", expected: { windows: "reserved-name" } },
    { name: "a superscript serial port", path: "COM\u00b9.md", expected: { windows: "reserved-name" } },
    { name: "the console input device", path: "CONIN$.md", expected: { windows: "reserved-name" } },
    { name: "the console output device", path: "conout$", expected: { windows: "reserved-name" } },
    { name: "a reserved name with more letters", path: "CONSOLE.md", expected: {} },
    { name: "a port without a digit", path: "COM.md", expected: {} },
    { name: "a port with two digits", path: "COM10.md", expected: {} },
    { name: "a reserved name inside a longer name", path: "my CON.md", expected: {} },
    { name: "a colon", path: "a:b.md", expected: { windows: "forbidden-character" } },
    { name: "a colon in a folder", path: "x:y/b.md", expected: { windows: "forbidden-character" } },
    { name: "a question mark", path: "why?.md", expected: { windows: "forbidden-character" } },
    { name: "an asterisk", path: "a*.md", expected: { windows: "forbidden-character" } },
    { name: "angle brackets", path: "<a>.md", expected: { windows: "forbidden-character" } },
    { name: "a double quote", path: 'say "hi".md', expected: { windows: "forbidden-character" } },
    { name: "a pipe", path: "a|b.md", expected: { windows: "forbidden-character" } },
    { name: "a backslash", path: "a\\b.md", expected: { windows: "forbidden-character" } },
    { name: "a control character", path: "a\u0001b.md", expected: { windows: "forbidden-character" } },
    { name: "a NUL character", path: "a\u0000b.md", expected: { posix: "forbidden-character", windows: "forbidden-character", macos: "forbidden-character" } },
    { name: "a trailing dot", path: "trailing.", expected: { windows: "trailing-dot-or-space" } },
    { name: "a trailing space", path: "trailing .md ", expected: { windows: "trailing-dot-or-space" } },
    { name: "a folder with a trailing dot", path: "notes./a.md", expected: { windows: "trailing-dot-or-space" } },
    { name: "a folder with a trailing space", path: "notes /a.md", expected: { windows: "trailing-dot-or-space" } },
    { name: "a leading space", path: " a.md", expected: {} },
  ];
  for (const { name, path, expected } of cases) {
    for (const platform of ["posix", "windows", "macos"] as const) {
      const reason = expected[platform];
      it(`${reason === undefined ? "accepts" : `refuses (${reason})`} ${name} on ${platform}`, () => {
        expect(unmaterializableReason(path, { platform })).toBe(reason);
      });
    }
  }

  describe("Android shared storage", () => {
    const android = { platform: "android" } as const;
    for (const character of ['"', "*", ":", "<", ">", "?", "\\", "|"]) {
      it(`refuses ${JSON.stringify(character)} in a name or a folder, which plain posix accepts`, () => {
        expect(unmaterializableReason(`a${character}b.md`, android)).toBe("forbidden-character");
        expect(unmaterializableReason(`x${character}y/b.md`, android)).toBe("forbidden-character");
        expect(unmaterializableReason(`a${character}b.md`, { platform: "posix" })).toBeUndefined();
      });
    }
    it("accepts what Windows forbids beyond that set: reserved names, trailing dots and spaces, control characters", () => {
      for (const path of ["CON.md", "trailing.", "trailing ", "a\u0001b.md", "a b. c.md"]) expect(unmaterializableReason(path, android)).toBeUndefined();
    });
    it("still refuses NUL and keeps the posix length limits", () => {
      expect(unmaterializableReason("a\u0000b.md", android)).toBe("forbidden-character");
      expect(unmaterializableReason(`notes/${repeat("a", 255)}`, android)).toBeUndefined();
      expect(unmaterializableReason(`notes/${repeat("a", 256)}`, android)).toBe("name-too-long");
      // A path of `length` bytes in folders of 199 bytes: 4095 is the longest PATH_MAX (4096 with the terminator) allows.
      const pathOf = (length: number) => (repeat(`${repeat("f", 199)}/`, 20) + repeat("a", 200)).slice(0, length);
      expect(new TextEncoder().encode(pathOf(4096)).length).toBe(4096);
      expect(unmaterializableReason(pathOf(4095), android)).toBeUndefined();
      expect(unmaterializableReason(pathOf(4096), android)).toBe("path-too-long");
      expect(unmaterializableReason(pathOf(4095 - "/storage/emulated/0/v/".length), { ...android, root: "/storage/emulated/0/v" })).toBeUndefined();
      expect(unmaterializableReason(pathOf(4096 - "/storage/emulated/0/v/".length), { ...android, root: "/storage/emulated/0/v" })).toBe("path-too-long");
    });
  });

  describe("name length", () => {
    it("allows 255 UTF-8 bytes in a name on posix and macos, and refuses 256", () => {
      for (const platform of ["posix", "macos"] as const) {
        // "é" is two bytes in UTF-8: 127 of them and one ASCII letter make 255 bytes.
        expect(unmaterializableReason(`notes/${repeat("é", 127)}a`, { platform })).toBeUndefined();
        expect(unmaterializableReason(`notes/${repeat("é", 128)}`, { platform })).toBe("name-too-long");
      }
    });

    it("allows 255 UTF-16 code units in a name on windows, and refuses 256", () => {
      // Two bytes in UTF-8 but one UTF-16 code unit each: fine on Windows at 255 characters.
      expect(unmaterializableReason(repeat("é", 255), { platform: "windows" })).toBeUndefined();
      expect(unmaterializableReason(repeat("é", 256), { platform: "windows" })).toBe("name-too-long");
      // An astral character is two UTF-16 code units.
      expect(unmaterializableReason(`${repeat("😀", 127)}a`, { platform: "windows" })).toBeUndefined();
      expect(unmaterializableReason(repeat("😀", 128), { platform: "windows" })).toBe("name-too-long");
    });

    it("applies to folder names too", () => {
      expect(unmaterializableReason(`${repeat("a", 256)}/b.md`, { platform: "posix" })).toBe("name-too-long");
    });
  });

  describe("path length", () => {
    it("allows 259 UTF-16 code units of path on windows, root and separator included, and refuses 260", () => {
      const root = "C:\\Users\\me\\Vault";
      // root + "\" + relative path: 17 + 1 + 241 = 259.
      const relative = `${repeat("a", 200)}/${repeat("b", 40)}`;
      expect(root.length + 1 + relative.length).toBe(259);
      expect(unmaterializableReason(relative, { platform: "windows", root })).toBeUndefined();
      expect(unmaterializableReason(`${relative}c`, { platform: "windows", root })).toBe("path-too-long");
      // Without a root, only the vault-relative path counts.
      expect(unmaterializableReason(`${relative}c`, { platform: "windows" })).toBeUndefined();
      expect(unmaterializableReason(`${repeat("a", 200)}/${repeat("b", 58)}`, { platform: "windows" })).toBeUndefined();
      expect(unmaterializableReason(`${repeat("a", 200)}/${repeat("b", 59)}`, { platform: "windows" })).toBe("path-too-long");
    });

    it("allows 1023 UTF-8 bytes of path on macos, root and separator included, and refuses 1024", () => {
      const root = "/Users/me/Vault";
      const relative = [repeat("a", 250), repeat("b", 250), repeat("c", 250), repeat("d", 254)].join("/");
      expect(root.length + 1 + relative.length).toBe(1023);
      expect(unmaterializableReason(relative, { platform: "macos", root })).toBeUndefined();
      expect(unmaterializableReason(`${relative}e`, { platform: "macos", root })).toBe("path-too-long");
    });

    it("allows 4095 UTF-8 bytes of path on posix, root and separator included, and refuses 4096", () => {
      const root = "/home/me/Vault";
      const segments = Array.from({ length: 16 }, () => repeat("a", 250));
      // 14 + 1 + 16 * 250 + 16 separators + 64 = 4095.
      const relative = `${segments.join("/")}/${repeat("b", 64)}`;
      expect(root.length + 1 + new TextEncoder().encode(relative).length).toBe(4095);
      expect(unmaterializableReason(relative, { platform: "posix", root })).toBeUndefined();
      expect(unmaterializableReason(`${relative}c`, { platform: "posix", root })).toBe("path-too-long");
    });
  });
});

describe("filesystemKey", () => {
  const nfc = "Café.md";
  const nfd = "Café.md";
  // Whether each platform's filesystem takes the two spellings for one file.
  const cases: { name: string; a: string; b: string; expected: Record<PathPlatform, boolean> }[] = [
    { name: "one spelling", a: "notes/Foo.md", b: "notes/Foo.md", expected: { posix: true, macos: true, windows: true, android: true } },
    { name: "spellings differing only by ASCII case", a: "notes/Foo.md", b: "NOTES/foo.MD", expected: { posix: false, macos: true, windows: true, android: true } },
    { name: "spellings differing only by non-ASCII case", a: "Été.md", b: "éTÉ.md", expected: { posix: false, macos: true, windows: true, android: true } },
    { name: "Greek final and medial sigma", a: "ΟΔΟΣ.md", b: "οδοσ.md", expected: { posix: false, macos: true, windows: true, android: true } },
    { name: "NFC and NFD spellings", a: nfc, b: nfd, expected: { posix: false, macos: true, windows: false, android: false } },
    { name: "NFC and NFD spellings in another case", a: nfc, b: "CAFÉ.MD", expected: { posix: false, macos: true, windows: false, android: false } },
    { name: "ß and SS", a: "Straße.md", b: "STRASSE.md", expected: { posix: false, macos: false, windows: false, android: false } },
    { name: "ß and ss", a: "Straße.md", b: "strasse.md", expected: { posix: false, macos: false, windows: false, android: false } },
    // NTFS's upcase table maps k to K, never to the Kelvin sign; on macOS the sign's canonical decomposition is K.
    { name: "the Kelvin sign and k", a: "K.md", b: "k.md", expected: { posix: false, macos: true, windows: false, android: false } },
    // The upper case of the dotless ı is I: NTFS, APFS and Android's shared storage take them for one name, which the path key does not (§6.4 item 4).
    { name: "the dotless ı and I", a: "ı.md", b: "I.md", expected: { posix: false, macos: true, windows: true, android: true } },
    { name: "different names", a: "Foo.md", b: "Bar.md", expected: { posix: false, macos: false, windows: false, android: false } },
  ];

  for (const platform of ["posix", "macos", "windows", "android"] as const) {
    describe(`on ${platform}`, () => {
      for (const { name, a, b, expected } of cases) {
        it(`${expected[platform] ? "takes" : "does not take"} ${name} for one file`, () => {
          expect(filesystemKey(a, platform) === filesystemKey(b, platform)).toBe(expected[platform]);
        });
      }
    });
  }
});
