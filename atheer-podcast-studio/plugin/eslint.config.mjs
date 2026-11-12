import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import typescript from "typescript-eslint";
import premierepro from "@adobe/eslint-plugin-premierepro";

export default defineConfig(
  globalIgnores(["dist/**", "node_modules/**", "eslint.config.mjs", "build.mjs"]),
  {
    files: ["src/**/*.ts"],
    extends: [
      eslint.configs.recommended,
      typescript.configs.recommended,
      // Adobe's rules: Action creation inside lockedAccess, no async work in
      // protected callbacks, correct TrackItemSelection scope, etc.
      premierepro.configs.recommendedTypeChecked,
    ],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
