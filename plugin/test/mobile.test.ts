/// <reference types="node" />
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { releaseExternals } from "../scripts/externals";

// What lets the plugin install and load on Obsidian mobile (Android), which
// the desktop and emulated-mobile e2e cannot show: both run on Electron, with
// Node available (docs/testing/android.md).
const pluginDir = fileURLToPath(new URL("..", import.meta.url));

/** Modules Obsidian provides to plugins on every platform, mobile included. */
function providedOnMobile(specifier: string): boolean {
  return specifier === "obsidian" || specifier.startsWith("@codemirror/") || specifier.startsWith("@lezer/");
}

describe("the plugin on Obsidian mobile", () => {
  it("is not marked desktop-only in the manifest users install, so it installs on Android", () => {
    // BRAT and the community store install the release's copy of this file.
    const manifest = JSON.parse(readFileSync(`${pluginDir}/manifest.json`, "utf8")) as Record<string, unknown>;
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it("loads no module that only desktop has (Node built-ins, Electron)", async () => {
    // Bundles src/main.ts as the release build does, leaving every module the
    // release build leaves to Obsidian (the same list) unbundled, and lists
    // what the bundle still loads at runtime. On Android, `require` has only
    // Obsidian's own. The `node:` spellings of the built-ins are left
    // unbundled too, only so an import of one is listed here: the release
    // build fails on it instead.
    const result = await build({
      absWorkingDir: pluginDir,
      entryPoints: ["src/main.ts"],
      bundle: true,
      write: false,
      metafile: true,
      format: "cjs",
      target: "es2022",
      logLevel: "silent",
      external: [...releaseExternals, ...builtinModules.map((name) => `node:${name}`)],
    });
    const loaded = new Set(
      Object.values(result.metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((imported) => imported.external)
        .map((imported) => imported.path),
    );

    expect([...loaded].filter((specifier) => !providedOnMobile(specifier))).toEqual([]);
    expect(loaded).toContain("obsidian");
  });
});
