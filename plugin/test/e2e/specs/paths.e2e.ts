import { browser, expect } from "@wdio/globals";

import { callHarness } from "../obsidian";

// The path rule must hold on the exact string the file system gets (#148).
// Obsidian's normalizePath maps U+00A0 and U+202F to a space, so a segment
// such as ".." followed by U+00A0 passes the shared rule
// (testdata/paths/validity.json) but would become ".. ", a segment the rule
// treats as "..", if anything normalized it before touching the disk. Both
// Obsidian adapters refuse every path normalizePath would change, so such a
// path never reaches the disk in either form.

const spaces = [
  ["a no-break space", "\u00a0"],
  ["a narrow no-break space", "\u202f"],
] as const;

describe("Paths that Obsidian's normalizePath would change", function () {
  for (const [name, space] of spaces) {
    // Before the dots the segment is not hidden, so only the normalizePath
    // check can refuse it.
    for (const [where, segment, normalized] of [
      ["after", `..${space}`, ".. "],
      ["before", `${space}..`, " .."],
    ] as const) {
      it(`are refused by the vault adapter: a dot-dot segment with ${name} ${where} the dots`, async function () {
        const path = `${segment}/evil.md`;

        const result = await callHarness("pathScope", path);

        // What makes the order matter: the rule accepts the received string,
        // and normalizePath turns it into a segment the rule refuses.
        expect(result.accepted).toBe(true);
        expect(result.normalized).toBe(`${normalized}/evil.md`);
        expect(result.normalizedAccepted).toBe(false);
        // The adapter neither writes nor renames onto it, and nothing but
        // inside.md is in the vault.
        expect(result.write).toBe("path-conflict");
        expect(result.rename).toBe("path-conflict");
        expect(result.read).toBe("not-found");
        expect(result.stat).toBeNull();
        expect(result.listed).toEqual(["inside.md"]);
        expect(result.inside).toBe("inside\n");
      });

      it(`are refused by the config folder adapter: a dot-dot segment with ${name} ${where} the dots`, async function () {
        const result = await callHarness("configPathScope", `${segment}/evil.json`);

        expect(result.write).toBe("path-conflict");
        expect(result.rename).toBe("path-conflict");
        expect(result.files).toHaveLength(1);
        expect(result.files[0]).toMatch(/\/vault-sync-e2e-paths\/inside\.json$/u);
      });
    }
  }

  it("never reach the disk when the server sends one", async function () {
    await callHarness("setUpSession");
    await callHarness("commitRemote", "doc-after", "..\u00a0/evil.md", "outside the vault\n");
    await callHarness("commitRemote", "doc-before", "\u00a0../evil.md", "outside the vault\n");
    await callHarness("startSession");

    const files = await browser.executeObsidian(({ app }) => app.vault.getFiles().map((file) => file.path).sort());
    expect(files).toEqual(["Synced.md"]);
  });
});
