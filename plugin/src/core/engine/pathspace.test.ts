import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
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

  it("tells one file from two files with one file key", () => {
    expect(windows.oneFile("Straße.md", "STRASSE.md")).toBe(false);
    expect(windows.fileKey("Straße.md")).toBe(windows.fileKey("STRASSE.md"));
    expect(windows.oneFile("Notes/a.md", "NOTES/A.md")).toBe(true);
    expect(windows.oneFile(nfc("Café.md"), nfd("Café.md"))).toBe(false);
    expect(macos.oneFile(nfc("Café.md"), nfd("Café.md"))).toBe(true);
    expect(posix.oneFile("a.md", "A.md")).toBe(false);
    expect(posix.oneFile("a.md", "a.md")).toBe(true);
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

describe.each(["windows", "macos"] as const)("documents at ı.md and I.md on %s, one file on the device (§6.4 item 4)", (platform) => {
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
    // The second document waits for the path, held as a deferred revision (rule W, refactor step R7, will place it).
    expect((await h.journal.listDeferred()).map((deferred) => deferred.revision.documentId)).toEqual(["capital"]);
  });
});

function text(content: Uint8Array): string {
  return new TextDecoder().decode(content);
}

