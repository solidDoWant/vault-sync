/// <reference types="node" />
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

// Type-checks probe sources placed under src/core with the real tsconfig files
// that `make lint` (npm run typecheck) uses. The probes are virtual: they are
// added to each program's root files through the compiler host and never
// touch the disk.
const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const coreDir = path.join(pluginDir, "src", "core");

function parseConfig(configName: string): ts.ParsedCommandLine {
  const configPath = path.join(pluginDir, configName);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (parsed === undefined) throw new Error(`cannot parse ${configName}`);
  expect(parsed.errors).toEqual([]);
  return parsed;
}

/** Builds one program from a tsconfig plus virtual probe files; returns each probe's error messages. */
function typeErrors(configName: string, probes: Record<string, string>): Record<string, string[]> {
  const config = parseConfig(configName);
  const probePaths = new Map(Object.entries(probes).map(([name, source], index) => [path.join(coreDir, "__probe__", `probe${String(index)}.ts`), { name, source }]));
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const probe = probePaths.get(path.resolve(fileName));
    if (probe !== undefined) return ts.createSourceFile(fileName, probe.source, languageVersion, true);
    return getSourceFile(fileName, languageVersion, ...rest);
  };
  host.fileExists = (fileName) => probePaths.has(path.resolve(fileName)) || fileExists(fileName);

  const program = ts.createProgram([...config.fileNames, ...probePaths.keys()], config.options, host);
  const result: Record<string, string[]> = {};
  for (const [probePath, { name }] of probePaths) {
    const sourceFile = program.getSourceFile(probePath);
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
    const pkg = JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toMatch(/tsc --noEmit -p tsconfig\.core\.json/);
  });
});
