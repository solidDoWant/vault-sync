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
  overrideConfig: [{ files: ["**/*.ts"], ...tseslint.configs.disableTypeChecked }],
});

async function fenceViolations(filePath: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath });
  if (result === undefined) throw new Error("eslint returned no result");
  const fatal = result.messages.filter((message) => message.fatal === true);
  expect(fatal).toEqual([]);
  return result.messages
    .filter((message) => message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-syntax")
    .map((message) => message.message);
}

describe("src/core import fence", () => {
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
  };

  for (const [name, source] of Object.entries(forbidden)) {
    it(`rejects ${name}`, async () => {
      expect(await fenceViolations("src/core/probe.ts", source)).not.toEqual([]);
      expect(await fenceViolations("src/core/nested/probe.ts", source)).not.toEqual([]);
    });
  }

  it("allows core-internal modules whose names merely contain 'obsidian'", async () => {
    const source = 'import { a } from "./obsidian-names";\nexport const b = a;\n';
    expect(await fenceViolations("src/core/probe.ts", source)).toEqual([]);
  });

  it("allows the adapter itself to import obsidian", async () => {
    const source = 'import { App } from "obsidian";\nexport const app: App | null = null;\n';
    expect(await fenceViolations("src/obsidian/probe.ts", source)).toEqual([]);
  });
});
