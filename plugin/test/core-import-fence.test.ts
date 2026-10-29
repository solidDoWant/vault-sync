/// <reference types="node" />
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

// Runs the real eslint.config.js (the one `make lint` uses) against probe
// sources placed at src/core and src/obsidian paths. Type-aware rules are
// disabled for the probes because they do not exist on disk; the import fence
// does not need type information.
const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({
  cwd: pluginDir,
  overrideConfig: [tseslint.configs.disableTypeChecked],
});

const fenceRules = new Set(["no-restricted-imports", "no-restricted-syntax", "@typescript-eslint/triple-slash-reference"]);

async function fenceViolations(filePath: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath });
  if (result === undefined) throw new Error("eslint returned no result");
  const fatal = result.messages.filter((message) => message.fatal === true);
  expect(fatal).toEqual([]);
  return result.messages
    .filter((message) => message.ruleId !== null && fenceRules.has(message.ruleId))
    .map((message) => message.message);
}

// Every form of reaching Obsidian, the src/obsidian adapter or the plugin entry
// point, each spelled relative to a file in src/core.
const forbidden: Record<string, string> = {
  "a value import from obsidian": 'import { App } from "obsidian";\nexport const app: App | null = null;\n',
  "a type-only import from obsidian": 'import type { App } from "obsidian";\nexport type A = App;\n',
  "a side-effect import of obsidian": 'import "obsidian";\n',
  "a subpath of obsidian": 'import { x } from "obsidian/internal";\nexport const y = x;\n',
  "a re-export from obsidian": 'export { App } from "obsidian";\n',
  "a star re-export from obsidian": 'export * from "obsidian";\n',
  "a dynamic import of obsidian": 'export const load = () => import("obsidian");\n',
  "a require of obsidian": 'declare const require: (id: string) => unknown;\nexport const o = require("obsidian");\n',
  "the adapter folder index": 'import { a } from "../obsidian";\nexport const b = a;\n',
  "a module in the adapter folder": 'import { a } from "../obsidian/adapter";\nexport const b = a;\n',
  "the adapter from a nested core folder": 'import { a } from "../../obsidian/adapter";\nexport const b = a;\n',
  "the adapter by src-rooted path": 'import { a } from "src/obsidian/adapter";\nexport const b = a;\n',
  "a dynamic import of the adapter": 'export const load = () => import("../obsidian/adapter");\n',
  "a dynamic import via a template literal": "export const load = () => import(`obsidian`);\n",
  "a dynamic import of the adapter via a template literal": "export const load = () => import(`../obsidian/adapter`);\n",
  "a require via a template literal": "declare const require: (id: string) => unknown;\nexport const o = require(`obsidian`);\n",
  "an inline type import": 'export type A = import("obsidian").App;\n',
  "an inline type import of the adapter": 'export type A = import("../obsidian/adapter").Adapter;\n',
  "an import-equals require": 'import o = require("obsidian");\nexport const p = o;\n',
  "a window.require of obsidian":
    'declare const window: { require: (id: string) => unknown };\nexport const o = window.require("obsidian");\n',
  "a globalThis.require of obsidian":
    'declare const globalThis: { require: (id: string) => unknown };\nexport const o = globalThis.require("obsidian");\n',
  "a module.require of obsidian":
    'declare const module: { require: (id: string) => unknown };\nexport const o = module.require("obsidian");\n',
  "a computed-member require of obsidian":
    'declare const window: { require: (id: string) => unknown };\nexport const o = window["require"]("obsidian");\n',
  "an optional member require of obsidian":
    'declare const window: { require?: (id: string) => unknown };\nexport const o = window.require?.("obsidian");\n',
  "a member require of the adapter":
    'declare const window: { require: (id: string) => unknown };\nexport const o = window.require("../obsidian/adapter");\n',
  "a triple-slash types reference to obsidian": '/// <reference types="obsidian" />\nexport {};\n',
  "a triple-slash path reference": '/// <reference path="../../node_modules/obsidian/obsidian.d.ts" />\nexport {};\n',
  "a triple-slash lib reference": '/// <reference lib="dom" />\nexport {};\n',
  "a type import from the plugin entry point": 'import type P from "../main";\nexport type Q = P;\n',
  "a value import from the plugin entry point": 'import P from "../../main.ts";\nexport const Q = P;\n',
  "a re-export from the plugin entry point": 'export { default } from "../main";\n',
  "the plugin entry point by src-rooted path": 'import type P from "src/main";\nexport type Q = P;\n',
  "a member require via a template literal":
    "declare const window: { require: (id: string) => unknown };\nexport const o = window.require(`obsidian`);\n",
};

// Each test runs eslint with the full config; the first one loads it.
describe("src/core import fence", { timeout: 30_000 }, () => {
  // Every TypeScript extension the core program can pull in (an .mts or .cts
  // file is reachable from a .ts import).
  for (const [name, source] of Object.entries(forbidden)) {
    for (const extension of [".ts", ".mts", ".cts", ".tsx"]) {
      it(`rejects ${name} in a ${extension} file`, async () => {
        expect(await fenceViolations(`src/core/probe${extension}`, source)).not.toEqual([]);
        expect(await fenceViolations(`src/core/nested/probe${extension}`, source)).not.toEqual([]);
      });
    }
  }

  const forbiddenDeclarations: Record<string, string> = {
    "a declare global block": "declare global {\n  var activeWindow: Window;\n}\nexport {};\n",
    "a declare global block nested in a module declaration": 'declare module "x" {\n  global {\n    var activeWindow: Window;\n  }\n}\nexport {};\n',
    "a triple-slash lib reference": '/// <reference lib="dom" />\nexport {};\n',
    "a triple-slash types reference": '/// <reference types="obsidian" />\nexport {};\n',
  };

  for (const [name, source] of Object.entries(forbiddenDeclarations)) {
    for (const fileName of ["probe.ts", "probe.mts", "probe.cts", "probe.d.ts", "probe.d.mts", "probe.d.cts"]) {
      it(`rejects ${name} in ${fileName}`, async () => {
        expect(await fenceViolations(`src/core/${fileName}`, source)).not.toEqual([]);
      });
    }
  }

  for (const extension of [".js", ".mjs", ".cjs"]) {
    it(`rejects a window.require of obsidian in a ${extension} file`, async () => {
      expect(await fenceViolations(`src/core/probe${extension}`, 'export const o = window.require("obsidian");\n')).not.toEqual([]);
    });
  }

  it("allows core-internal modules whose names merely contain 'obsidian'", async () => {
    const source = 'import { a } from "./obsidian-names";\nexport const b = a;\n';
    expect(await fenceViolations("src/core/probe.ts", source)).toEqual([]);
  });

  it("allows core-internal modules named main", async () => {
    const source = 'import { a } from "./main";\nimport { b } from "./engine/main";\nexport const c = [a, b];\n';
    expect(await fenceViolations("src/core/probe.ts", source)).toEqual([]);
  });

  it("allows member requires of other modules", async () => {
    const source = 'declare const window: { require: (id: string) => unknown };\nexport const o = window.require("electron");\n';
    expect(await fenceViolations("src/core/probe.ts", source)).toEqual([]);
  });

  it("allows the adapter itself to import obsidian", async () => {
    const source = 'import { App } from "obsidian";\nexport const app: App | null = null;\n';
    expect(await fenceViolations("src/obsidian/probe.ts", source)).toEqual([]);
  });
});
