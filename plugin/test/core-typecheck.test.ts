
/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkCoreProgram, coreConfig, createProgram, parseConfig, pluginDir } from "../scripts/check-core-program";

// Type-checks probe sources placed under src/core with the real tsconfig files
// and the real check that `make lint` (npm run typecheck) runs. The probes are
// virtual: they are served from memory through the compiler host and never
// touch the disk.
const coreDir = path.join(pluginDir, "src", "core");
const scriptPath = path.join(pluginDir, "scripts", "check-core-program.ts");
const obsidianTypes = path.join(pluginDir, "node_modules", "obsidian", "obsidian.d.ts");

/** Builds one program from a tsconfig plus virtual probe files; returns each probe's error messages. */
function typeErrors(configName: string, probes: Record<string, string>): Record<string, string[]> {
  const probeFiles = Object.entries(probes).map(([name, source], index) => ({ name, source, file: path.join(coreDir, "__probe__", `probe${String(index)}.ts`) }));
  const { program } = createProgram(configName, [], new Map(probeFiles.map(({ file, source }) => [file, source])));
  const result: Record<string, string[]> = {};
  for (const { name, file } of probeFiles) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) throw new Error(`probe ${name} not in program`);
    result[name] = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)].map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
  }
  return result;
}

const obsidianGlobals: Record<string, string> = {
  "activeWindow": "export const w = activeWindow;\n",
  "activeDocument": "export const d = activeDocument;\n",
  "createEl": 'export const e = createEl("div");\n',
  "createDiv": "export const e = createDiv();\n",
  "Array.prototype.contains": "export const has = [1, 2].contains(1);\n",
  "String.prototype.contains": 'export const has = "ab".contains("a");\n',
  "Array.prototype.first": "export const first = [1, 2].first();\n",
  "sleep": "export const s = sleep(1);\n",
};

// Globals that core legitimately uses and that Node and WebViews both provide.
const portableGlobals =
  "export const bytes = new TextEncoder().encode('x');\n" +
  "export const text = new TextDecoder().decode(bytes);\n" +
  "export const headers = new Headers({ a: 'b' });\n" +
  "export const load = () => fetch('https://example.invalid');\n" +
  "export const timer = setTimeout(() => undefined, 0);\n" +
  "export const url = new URL('https://example.invalid');\n" +
  "export const digest = () => crypto.subtle.digest('SHA-256', bytes);\n" +
  "export const abort = new AbortController();\n" +
  "console.debug(url.href);\n";

// DOM-only globals that are absent from Node.
const domOnlyGlobals: Record<string, string> = {
  window: "export const w = window;\n",
  document: "export const d = document;\n",
};

describe("src/core type-check program (tsconfig.core.json)", () => {
  let core: Record<string, string[]>;
  let obsidian: Record<string, string[]>;

  beforeAll(() => {
    core = typeErrors("tsconfig.core.json", { ...obsidianGlobals, ...domOnlyGlobals, portable: portableGlobals });
    obsidian = typeErrors("tsconfig.json", obsidianGlobals);
  }, 60_000);

  for (const name of Object.keys(obsidianGlobals)) {
    it(`rejects the Obsidian-only global ${name}`, () => {
      expect(core[name]).not.toEqual([]);
    });

    // Control: the plugin-wide program sees Obsidian's global augmentations,
    // so only the core program catches this.
    it(`accepts ${name} in the plugin-wide program`, () => {
      expect(obsidian[name]).toEqual([]);
    });
  }

  for (const name of Object.keys(domOnlyGlobals)) {
    it(`rejects the DOM-only global ${name}`, () => {
      expect(core[name]).not.toEqual([]);
    });
  }

  it("accepts the platform globals Node and WebViews share", () => {
    expect(core.portable).toEqual([]);
  });

  it("covers every src/core module and test, plus sim/, but not main.ts or the adapter", () => {
    const fileNames = parseConfig("tsconfig.core.json").fileNames.map((fileName) => path.relative(pluginDir, fileName));
    expect(fileNames).toContain(path.join("src", "core", "index.ts"));
    expect(fileNames).toContain(path.join("src", "core", "hash.test.ts"));
    expect(fileNames).toContain(path.join("src", "core", "vault", "memory.test.ts"));
    const allowed = [path.join("src", "core") + path.sep, path.join("..", "sim") + path.sep];
    expect(fileNames.filter((fileName) => !allowed.some((prefix) => fileName.startsWith(prefix)))).toEqual([]);
  });

  it("is run by npm run typecheck", () => {
    const pkg = JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8")) as { scripts: Record<string, string | undefined> };
    const typecheck = pkg.scripts.typecheck ?? "";
    // Every step must be able to fail the script.
    expect(typecheck).not.toMatch(/\|\||;/);
    expect(typecheck.split("&&").map((step) => step.trim())).toContain("node scripts/check-core-program.ts");
  });
});

// Each leak gets its own program: once obsidian.d.ts is in a program, its
// globals apply to every file in it, so `user` below type-checks there.
describe("Obsidian leaking into the src/core program", () => {
  const user = "export const w = activeWindow;\n";
  const relativeObsidianTypes = path.relative(path.join(coreDir, "zz"), obsidianTypes).split(path.sep).join("/");
  const leaks: Record<string, Record<string, string>> = {
    "a triple-slash types reference to obsidian": { "zz/leak.ts": '/// <reference types="obsidian" />\nexport {};\n' },
    "a triple-slash path reference to obsidian.d.ts": {
      "zz/leak.ts": `/// <reference path=${JSON.stringify(relativeObsidianTypes)} />\nexport {};\n`,
    },
    "a type import from src/main.ts": { "zz/leak.ts": 'import type VaultSyncPlugin from "../../main";\nexport type P = VaultSyncPlugin;\n' },
    "a value import from src/main.ts": { "leak.ts": 'import VaultSyncPlugin from "../main";\nexport const P = VaultSyncPlugin;\n' },
    "a transitive import through src/obsidian": {
      "zz/leak.ts": 'export { adapter } from "./helper";\n',
      "zz/helper.ts": 'export { adapter } from "../../obsidian/adapter";\n',
      "../obsidian/adapter.ts": 'import type { App } from "obsidian";\nexport const adapter: App | null = null;\n',
    },
  };

  for (const [name, files] of Object.entries(leaks)) {
    it(`fails on ${name}`, () => {
      const virtualFiles = new Map(Object.entries({ ...files, "zz/user.ts": user }).map(([file, source]) => [path.join(coreDir, file), source]));
      const problems = checkCoreProgram([], virtualFiles);
      expect(problems).toContainEqual(expect.stringMatching(/node_modules\/obsidian\/obsidian\.d\.ts is part of the src\/core program/));
    }, 60_000);
  }

  it("finds nothing in the committed src/core program", () => {
    expect(checkCoreProgram()).toEqual([]);
  }, 60_000);
});

describe("scripts/check-core-program.ts", () => {
  let tempDir = "";
  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "core-program-"));
  });
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function run(probeName?: string, source?: string): { status: number | null; stderr: string } {
    const args = [scriptPath];
    if (probeName !== undefined && source !== undefined) {
      const probe = path.join(tempDir, probeName);
      writeFileSync(probe, source);
      args.push(probe);
    }
    const result = spawnSync(process.execPath, args, { cwd: pluginDir, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  }

  it(`exits 0 for the committed ${coreConfig} program`, () => {
    expect(run()).toEqual({ status: 0, stderr: "" });
  }, 60_000);

  it("exits non-zero on a type error", () => {
    const result = run("type-error.ts", "export const w = activeWindow;\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot find name 'activeWindow'/);
  }, 60_000);

  it("exits non-zero when Obsidian reaches the program", () => {
    const result = run("leak.ts", `/// <reference path=${JSON.stringify(obsidianTypes)} />\nexport {};\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/obsidian\.d\.ts is part of the src\/core program/);
  }, 60_000);
});
