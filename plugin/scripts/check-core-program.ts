/// <reference types="node" />
// Type-checks the src/core program (tsconfig.core.json) and fails if anything
// can bring Obsidian, its globals or unchecked code into it:
//
// - Obsidian's `declare global` block applies to every file of a program as
//   soon as one file reaches obsidian.d.ts, whether through an import, a
//   `/// <reference>` or a transitive import of src/main.ts or src/obsidian.
//   So every source file of the program must come from an allowed place
//   (src/core, sim/, generated code, dependencies other than obsidian).
// - Code in src/core and sim/ is what the eslint fence and this check police,
//   so it must be plain `.ts` modules: no other extensions eslint might not
//   fence, no declaration files, no triple-slash directives, no
//   `declare global`, and no imports that resolve to JavaScript (which the
//   bundler would ship without any of these checks).
//
// Usage: node scripts/check-core-program.ts [extra-root-file ...]
// Run by `npm run typecheck` (and so by `make lint`).
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

export const pluginDir = fileURLToPath(new URL("..", import.meta.url));
export const coreConfig = "tsconfig.core.json";

/** Directories (relative to plugin/, `/`-separated) whose code this check and the eslint fence police. */
const ownedDirs = ["src/core/", "../sim/"];
/** Directories the program may additionally read from. */
const dependencyDirs = ["src/gen/", "node_modules/"];
const obsidianPattern = /(^|\/)node_modules\/obsidian\//;

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
): { program: ts.Program; host: ts.CompilerHost; configErrors: readonly ts.Diagnostic[] } {
  const config = parseConfig(configName);
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const source = virtualFiles.get(path.resolve(fileName));
    if (source !== undefined) return ts.createSourceFile(fileName, source, languageVersion, true);
    return getSourceFile(fileName, languageVersion, ...rest);
  };
  host.fileExists = (fileName) => virtualFiles.has(path.resolve(fileName)) || fileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(path.resolve(fileName)) ?? readFile(fileName);
  const rootFiles = [...config.fileNames, ...extraRootFiles.map((fileName) => path.resolve(fileName)), ...virtualFiles.keys()];
  return { program: ts.createProgram(rootFiles, config.options, host), host, configErrors: config.errors };
}

/** A path relative to plugin/, `/`-separated. */
function relative(fileName: string): string {
  return path.relative(pluginDir, path.resolve(fileName)).split(path.sep).join("/");
}

function isOwned(fileName: string): boolean {
  return ownedDirs.some((dir) => fileName.startsWith(dir));
}

/** Policed code must be `.ts` modules (JSON data is inert and allowed). */
function hasAllowedExtension(fileName: string): boolean {
  return fileName.endsWith(".json") || (fileName.endsWith(".ts") && !fileName.endsWith(".d.ts"));
}

/** Source files of the program that belong to Obsidian or the plugin shell, relative to plugin/. */
export function obsidianFiles(program: ts.Program): string[] {
  return program
    .getSourceFiles()
    .map((sourceFile) => relative(sourceFile.fileName))
    .filter((fileName) => obsidianPattern.test(fileName) || fileName === "src/main.ts" || fileName.startsWith("src/obsidian/"));
}

function hasGlobalAugmentation(node: ts.Node): boolean {
  if (ts.isModuleDeclaration(node) && (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0) return true;
  return ts.forEachChild(node, hasGlobalAugmentation) ?? false;
}

/** Problems with one policed source file of the program. */
function ownedFileProblems(sourceFile: ts.SourceFile, program: ts.Program, host: ts.CompilerHost): string[] {
  const fileName = relative(sourceFile.fileName);
  if (!hasAllowedExtension(fileName)) {
    return [`${fileName}: only .ts modules may be part of the src/core program (no other extensions, no declaration files).`];
  }
  if (fileName.endsWith(".json")) return [];
  const problems: string[] = [];
  if (sourceFile.referencedFiles.length + sourceFile.typeReferenceDirectives.length + sourceFile.libReferenceDirectives.length > 0) {
    problems.push(`${fileName}: triple-slash directives are not allowed; they add declarations to the whole src/core program.`);
  }
  if (hasGlobalAugmentation(sourceFile)) {
    problems.push(`${fileName}: \`declare global\` is not allowed; it adds globals to the whole src/core program.`);
  }
  if (!ts.isExternalModule(sourceFile)) {
    problems.push(`${fileName}: must be a module; top-level declarations of a script are globals.`);
  }
  const options = program.getCompilerOptions();
  for (const imported of ts.preProcessFile(sourceFile.text, true, true).importedFiles) {
    const resolved = ts.resolveModuleName(imported.fileName, sourceFile.fileName, options, host).resolvedModule;
    if (resolved === undefined) {
      problems.push(`${fileName}: import "${imported.fileName}" does not resolve.`);
    } else if (/\.[cm]?jsx?$/.test(resolved.resolvedFileName)) {
      problems.push(`${fileName}: import "${imported.fileName}" resolves to JavaScript (${relative(resolved.resolvedFileName)}), which is neither type-checked nor fenced.`);
    }
  }
  return problems;
}

/** Files on disk under src/core (plus virtual ones) that are not plain `.ts` modules. */
function coreDirectoryProblems(virtualFiles: ReadonlyMap<string, string>): string[] {
  const coreDir = path.join(pluginDir, "src", "core");
  const onDisk = readdirSync(coreDir, { recursive: true, encoding: "utf8" })
    .map((entry) => path.join(coreDir, entry))
    .filter((fileName) => statSync(fileName).isFile());
  const files = new Set([...onDisk, ...virtualFiles.keys()].map(relative).filter((fileName) => fileName.startsWith("src/core/")));
  return [...files]
    .filter((fileName) => !hasAllowedExtension(fileName))
    .map((fileName) => `${fileName}: src/core may only contain .ts modules (no other extensions, no declaration files).`);
}

/** Every problem with the core program. */
export function checkCoreProgram(extraRootFiles: readonly string[] = [], virtualFiles: ReadonlyMap<string, string> = new Map()): string[] {
  const { program, host, configErrors } = createProgram(coreConfig, extraRootFiles, virtualFiles);
  const formatHost: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => pluginDir,
    getNewLine: () => "\n",
  };
  const problems = [...configErrors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) =>
    ts.formatDiagnostic(diagnostic, formatHost).trimEnd(),
  );
  const leaked = new Set(obsidianFiles(program));
  for (const fileName of leaked) {
    problems.push(
      `${coreConfig}: ${fileName} is part of the src/core program; something in src/core references obsidian, src/main.ts or src/obsidian (directly or transitively).`,
    );
  }
  for (const sourceFile of program.getSourceFiles()) {
    const fileName = relative(sourceFile.fileName);
    if (isOwned(fileName)) {
      problems.push(...ownedFileProblems(sourceFile, program, host));
    } else if (!leaked.has(fileName) && !dependencyDirs.some((dir) => fileName.startsWith(dir)) && !fileName.endsWith(".json")) {
      problems.push(`${coreConfig}: ${fileName} is part of the src/core program but outside src/core, sim/, src/gen and dependencies, so it is not fenced.`);
    }
  }
  problems.push(...coreDirectoryProblems(virtualFiles));
  return problems;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const problems = checkCoreProgram(process.argv.slice(2));
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
