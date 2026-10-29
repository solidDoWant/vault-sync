/// <reference types="node" />
// Bundles the Argon2id Web Worker (src/core/e2ee/argon2-worker-entry.ts,
// hash-wasm inside) into one script, for a build to inline into its bundle as
// ARGON2_WORKER_SOURCE (src/core/e2ee/argon2.ts starts it from a Blob URL).
// Used by the release build (esbuild.config.mjs) and the e2e harness build
// (wdio.conf.mts).
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "core", "e2ee", "argon2-worker-entry.ts");

/** The esbuild `define` that inlines the bundled worker script. */
export async function argon2WorkerDefine(): Promise<Record<string, string>> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "warning",
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error("argon2 worker: esbuild wrote no output");
  return { ARGON2_WORKER_SOURCE: JSON.stringify(output.text) };
}
