import esbuild from "esbuild";

import { argon2WorkerDefine } from "./scripts/argon2-worker.ts";
import { releaseExternals } from "./scripts/externals.ts";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Provided by Obsidian at runtime; never bundled. test/mobile.test.ts
  // checks that mobile provides them all.
  external: [...releaseExternals],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  outfile: "dist/main.js",
  // The Argon2id Web Worker's script, inlined (src/core/e2ee/argon2.ts).
  define: await argon2WorkerDefine(),
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
