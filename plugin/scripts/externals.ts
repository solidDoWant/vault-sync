/// <reference types="node" />
// The modules the release build (esbuild.config.mjs) leaves unbundled, for
// Obsidian to provide at runtime. The mobile-loadability test
// (test/mobile.test.ts) bundles with this same list, so a module added here
// is one it checks Obsidian mobile provides.
import { builtinModules } from "node:module";

export const releaseExternals: readonly string[] = ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules];
