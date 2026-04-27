import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "node_modules/**",
    "dist/**",
    "out/**",
    "build/**",
    "coverage/**",
    "*.min.js",
    "next-env.d.ts",
    // Project build/test artifacts:
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "*.min.js",
  ]),
]);

export default eslintConfig;
