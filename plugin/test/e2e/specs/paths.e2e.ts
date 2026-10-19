import { browser, expect } from "@wdio/globals";

import { callHarness } from "../obsidian";

// The path rule must hold on the exact string the file system gets (#148).
// Obsidian's normalizePath maps U+00A0 and U+202F to a space, so
// "..\u00a0" passes the shared rule (testdata/paths/validity.json) but
// would become ".. ", a segment the rule treats as "..", if anything
// normalized it before touching the disk. The Obsidian adapter refuses
// every path normalizePath changes, so such a path never reaches the disk
// in either form.

describe("Paths that Obsidian's normalizePath would change", function () {
  for (const [name, space] of [
    ["a no-break space", "\u00a0"],
    ["a narrow no-break space", "\u202f"],
  ] as const) {
    it(`are refused by the adapter: a dot-dot segment ending in ${name}`, async function () {
      const path = `..${space}/evil.md`;

      const result = await callHarness("pathScope", path);

      // What makes the order matter: the rule accepts the received string,
      // and normalizePath turns it into a traversal.
      expect(result.accepted).toBe(true);
      expect(result.normalized).toBe(".. /evil.md");
      expect(result.normalizedAccepted).toBe(false);
      // The adapter neither writes nor renames onto it, and nothing outside
      // inside.md appears.
      expect(result.write).toBe("path-conflict");
      expect(result.rename).toBe("path-conflict");
      expect(result.read).toBe("not-found");
      expect(result.stat).toBeNull();
      expect(result.listed).toEqual(["inside.md"]);
      expect(result.inside).toBe("inside\n");
    });
  }

  it("never reach the disk when the server sends one", async function () {
    await callHarness("setUpSession");
    await callHarness("commitRemote", "doc-evil", "..\u00a0/evil.md", "outside the vault\n");
    await callHarness("startSession");

    const files = await browser.executeObsidian(({ app }) => app.vault.getFiles().map((file) => file.path).sort());
    expect(files).toEqual(["Synced.md"]);
  });
});
