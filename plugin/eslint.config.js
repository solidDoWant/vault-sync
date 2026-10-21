import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Matches any module specifier with an `obsidian` path segment: the `obsidian`
// package (and subpaths) and the src/obsidian adapter. esquery regexes cannot
// contain a literal slash, so the selector form spells it as a \u escape.
const OBSIDIAN_SPECIFIER = "(^|/)obsidian(/|$)";
const OBSIDIAN_SELECTOR_REGEX = `/${OBSIDIAN_SPECIFIER.replaceAll("/", "\\u002F")}/`;
// A call whose callee is `require` itself or a member named `require`
// (window.require, globalThis.require, module.require, x["require"]).
const REQUIRE_CALLEE = ":matches([callee.name='require'], [callee.property.name='require'], [callee.property.value='require'])";
const OBSIDIAN_MESSAGE = "src/core must not depend on Obsidian or src/obsidian; go through VaultAdapter.";
// The plugin entry point src/main.ts, reached by climbing out of src/core
// (`../main`, `../../main.ts`) or by a src-rooted path. scripts/check-core-program.ts
// catches every other route into the core program.
const MAIN_SPECIFIER = "^((\\.\\./)+|(.*/)?src/)main(\\.[cm]?[jt]s)?$";
const MAIN_MESSAGE = "src/core must not import the plugin entry point (src/main.ts); it pulls in Obsidian.";

// The import fence of the platform-independent sync engine: no Obsidian, no
// src/obsidian adapter, no plugin entry point, no globals. Applied to src/core
// below and to the simulation harness by sim/eslint.config.js, which drives
// the engine in Node.
export const coreFenceRules = {
  // Static imports, re-exports and `import x = require(...)`.
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        { regex: OBSIDIAN_SPECIFIER, message: OBSIDIAN_MESSAGE },
        // src/main.ts imports obsidian, so importing it (even for types)
        // brings Obsidian's globals into the core program.
        { regex: MAIN_SPECIFIER, message: MAIN_MESSAGE },
      ],
    },
  ],
  // `/// <reference types="obsidian" />` (or a path/lib reference) adds
  // declarations to the whole core program without an import.
  "@typescript-eslint/triple-slash-reference": ["error", { lib: "never", path: "never", types: "never" }],
  // Forms no-restricted-imports does not see.
  "no-restricted-syntax": [
    "error",
    ...[
      // import("obsidian")
      `ImportExpression[source.value=${OBSIDIAN_SELECTOR_REGEX}]`,
      // import(`obsidian`)
      `ImportExpression > TemplateLiteral.source > TemplateElement[value.cooked=${OBSIDIAN_SELECTOR_REGEX}]`,
      // require("obsidian"), window.require("obsidian"), module["require"]("obsidian")
      `CallExpression${REQUIRE_CALLEE}[arguments.0.value=${OBSIDIAN_SELECTOR_REGEX}]`,
      // require(`obsidian`) and its member forms
      `CallExpression${REQUIRE_CALLEE} > TemplateLiteral.arguments > TemplateElement[value.cooked=${OBSIDIAN_SELECTOR_REGEX}]`,
      // type T = import("obsidian").App
      `TSImportType[source.value=${OBSIDIAN_SELECTOR_REGEX}]`,
    ].map((selector) => ({ selector, message: OBSIDIAN_MESSAGE })),
    {
      // `declare global { ... }` (also nested in `declare module`) adds
      // globals such as activeWindow to the whole core program.
      selector: "TSModuleDeclaration[kind='global']",
      message: "src/core must not declare globals; they would apply to the whole core program.",
    },
  ],
};

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src/gen/", "*.config.*js", "vitest.config.ts", "vitest.integration.config.ts", "vitest.sim.config.ts", "wdio.conf.mts", "test/e2e/harness/dist/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The sync engine must stay platform-independent so the simulation
    // harness can drive it against an in-memory vault (SPEC.md §4).
    // test/core-import-fence.test.ts proves each form below is rejected.
    // `src/core/**` (rather than an extension list) applies the fence to
    // every file eslint lints there, whatever its extension (.ts, .mts, .cts,
    // .tsx, .d.ts, .js, ...). scripts/check-core-program.ts additionally
    // rejects any src/core file that is not a plain .ts module.
    files: ["src/core/**"],
    rules: coreFenceRules,
  },
);
