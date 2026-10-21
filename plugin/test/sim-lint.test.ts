/// <reference types="node" />
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Lints probe sources as a file of the simulation harness (../sim) the way
// `npm run lint` (`make lint`) does: from plugin/, through sim/eslint.config.js
// with its type-aware rules. The probe replaces the text of an existing harness
// module, so it is part of the type-checked program (plugin/tsconfig.core.json).
const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const probePath = "../sim/ids.ts";
const probeFile = resolve(pluginDir, probePath);
// typescript-eslint switches to single-run mode when CI=true and then types
// only the files on disk, which would ignore the probe text; keep it off.
const eslint = new ESLint({
  cwd: pluginDir,
  overrideConfig: { languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } } },
});

async function lint(source: string): Promise<ESLint.LintResult> {
  const [result] = await eslint.lintText(source, { filePath: probePath });
  if (result === undefined) throw new Error("eslint returned no result");
  expect(result.messages.filter((message) => message.fatal === true)).toEqual([]);
  return result;
}

describe("simulation harness lint", () => {
  it("reports a floating promise in a sim file and names the file", async () => {
    const result = await lint("export async function work(): Promise<void> {}\nwork();\n");
    expect(result.filePath).toBe(probeFile);
    expect(result.messages.map((message) => message.ruleId)).toContain("@typescript-eslint/no-floating-promises");
  });

  it("accepts the same code once the promise is handled", async () => {
    const result = await lint("export async function work(): Promise<void> {}\nawait work();\n");
    expect(result.messages).toEqual([]);
  });

  it("is part of npm run lint, which make lint runs", async () => {
    const manifest = JSON.parse(readFileSync(resolve(pluginDir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const [command, ...targets] = (manifest.scripts.lint ?? "").split(" && ")[0]?.trim().split(/\s+/) ?? [];
    expect(command).toBe("eslint");
    const covering = targets.filter((target) => !relative(resolve(pluginDir, target), probeFile).startsWith(".."));
    expect(covering).not.toEqual([]);
    expect(await eslint.isPathIgnored(probeFile)).toBe(false);
  });
});
