/// <reference types="node" />
// Type-checks the src/core program (tsconfig.core.json) and fails if anything
// pulls Obsidian into it. Obsidian's `declare global` block applies to every
// file of a program as soon as one file reaches obsidian.d.ts, whether through
// an import, a `/// <reference>` or a transitive import of src/main.ts or
// src/obsidian, so the check is on the program's actual source set rather
// than on individual specifiers.
//
// Usage: node scripts/check-core-program.ts [extra-root-file ...]
// Run by `npm run typecheck` (and so by `make lint`).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

export const pluginDir = fileURLToPath(new URL("..", import.meta.url));
export const coreConfig = "tsconfig.core.json";

export function parseConfig(configName: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(pluginDir, configName), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (parsed === undefined) throw new Error(`cannot parse ${configName}`);
  return parsed;
}

/**
 * Builds the program for a tsconfig in this directory. `extraRootFiles` are
 * added as root files; `virtualFiles` (absolute path to source) are served
 * from memory instead of disk.
 */
export function createProgram(
  configName: string,
  extraRootFiles: readonly string[] = [],
  virtualFiles: ReadonlyMap<string, string> = new Map(),
): { program: ts.Program; configErrors: readonly ts.Diagnostic[] } {
  const config = parseConfig(configName);
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const source = virtualFiles.get(path.resolve(fileName));
    if (source !== undefined) return ts.createSourceFile(fileName, source, languageVersion, true);
    return getSourceFile(fileName, languageVersion, ...rest);
  };
  host.fileExists = (fileName) => virtualFiles.has(path.resolve(fileName)) || fileExists(fileName);
  const rootFiles = [...config.fileNames, ...extraRootFiles.map((fileName) => path.resolve(fileName)), ...virtualFiles.keys()];
  return { program: ts.createProgram(rootFiles, config.options, host), configErrors: config.errors };
}

/** Source files of the program that belong to Obsidian or the plugin shell, relative to plugin/. */
export function obsidianFiles(program: ts.Program): string[] {
  return program
    .getSourceFiles()
    .map((sourceFile) => path.relative(pluginDir, path.resolve(sourceFile.fileName)).split(path.sep).join("/"))
    .filter(
      (fileName) => /(^|\/)node_modules\/obsidian\//.test(fileName) || fileName === "src/main.ts" || fileName.startsWith("src/obsidian/"),
    );
}

/** Every problem with the core program: type errors and Obsidian files that reached it. */
export function checkCoreProgram(extraRootFiles: readonly string[] = [], virtualFiles?: ReadonlyMap<string, string>): string[] {
  const { program, configErrors } = createProgram(coreConfig, extraRootFiles, virtualFiles);
  const formatHost: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => pluginDir,
    getNewLine: () => "\n",
  };
  const diagnostics = [...configErrors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) =>
    ts.formatDiagnostic(diagnostic, formatHost).trimEnd(),
  );
  const leaks = obsidianFiles(program).map(
    (fileName) =>
      `${coreConfig}: ${fileName} is part of the src/core program; something in src/core references obsidian, src/main.ts or src/obsidian (directly or transitively).`,
  );
  return [...diagnostics, ...leaks];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const problems = checkCoreProgram(process.argv.slice(2));
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
