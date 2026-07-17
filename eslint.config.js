// Shared flat ESLint config for every TS package in the monorepo.
// Each package's `lint` script points here explicitly
// (`eslint . --config ../../eslint.config.js`) rather than relying on
// upward resolution, so behavior is identical locally and in CI.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/next-env.d.ts",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
