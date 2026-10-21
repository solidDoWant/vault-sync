import js from "@eslint/js";
import tseslint from "typescript-eslint";

import { coreFenceRules } from "../plugin/eslint.config.js";

// The simulation harness drives the sync engine (plugin/src/core) in Node and
// is type-checked with it (plugin/tsconfig.core.json). ESLint only lints files
// under a config file's directory, so the harness has its own config here;
// `npm run lint` in plugin/ (`make lint`) lints this directory with it.
// Packages resolve through sim/node_modules, a symlink to plugin/node_modules.
export default tseslint.config(
  { ignores: ["node_modules", "regressions/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "../plugin/tsconfig.core.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // This config file is not part of the core program.
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The harness must not reach Obsidian either: it runs the engine as the
    // platform-independent core (SPEC.md §4). test/core-import-fence.test.ts
    // proves the fence applies here; scripts/check-core-program.ts checks the
    // resulting program as well. Every script extension, not just .ts (the
    // Go driver and tests here are not ESLint's).
    files: ["**/*.{ts,mts,cts,tsx,js,mjs,cjs}"],
    rules: coreFenceRules,
  },
);
