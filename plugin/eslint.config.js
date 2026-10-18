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

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src/gen/", "*.config.*js", "vitest.config.ts"] },
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
    files: ["src/core/**/*.ts"],
    rules: {
      // Static imports, re-exports and `import x = require(...)`.
      "no-restricted-imports": ["error", { patterns: [{ regex: OBSIDIAN_SPECIFIER, message: OBSIDIAN_MESSAGE }] }],
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
      ],
    },
  },
);
