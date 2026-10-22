import { describe, expect, it } from "vitest";

import { files, harness, PropertyWorld } from "./testing";

// The engine unit tests and the property suite run on a vault that holds what
// NTFS and APFS hold (#797, X-18 in docs/design/engine-path-ownership.md §5.5):
// `Straße.md` and `STRASSE.md` are two files, `a.md` and `A.md` one.
describe.each(["windows", "macos"] as const)("the engine test vault on %s", (platform) => {
  it("holds two spellings as one file only where the platform's filesystem does", async () => {
    for (const vault of [harness({ pathRules: { platform } }).vault, new PropertyWorld(platform).vault]) {
      await vault.write("Straße.md", new TextEncoder().encode("1\n"));
      await vault.write("STRASSE.md", new TextEncoder().encode("2\n"));
      await vault.write("a.md", new TextEncoder().encode("3\n"));
      await vault.write("A.md", new TextEncoder().encode("4\n"));
      expect(await files(vault)).toEqual(new Map([["STRASSE.md", "2\n"], ["Straße.md", "1\n"], ["a.md", "4\n"]]));
    }
  });
});
