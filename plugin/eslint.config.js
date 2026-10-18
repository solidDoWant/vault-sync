import js from "@eslint/js";
import tseslint from "typescript-eslint";

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
    // Any specifier with an `obsidian` path segment is forbidden: the
    // `obsidian` package (and subpaths) and the src/obsidian adapter.
    // test/core-import-fence.test.ts proves each form is rejected.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)obsidian(/|$)",
              message: "src/core must not depend on Obsidian or src/obsidian; go through VaultAdapter.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // esquery regexes cannot contain a literal "/", hence /.
          selector: "ImportExpression[source.value=/(^|\\u002F)obsidian(\\u002F|$)/]",
          message: "src/core must not depend on Obsidian or src/obsidian; go through VaultAdapter.",
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/(^|\\u002F)obsidian(\\u002F|$)/]",
          message: "src/core must not depend on Obsidian or src/obsidian; go through VaultAdapter.",
        },
      ],
    },
  },
);
