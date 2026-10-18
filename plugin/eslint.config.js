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
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "obsidian", message: "src/core must not depend on Obsidian; go through VaultAdapter." }],
          patterns: [{ group: ["**/obsidian/**", "../obsidian/*"], message: "src/core must not import the Obsidian adapter." }],
        },
      ],
    },
  },
);
