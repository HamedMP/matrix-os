import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["node"],
    alias: {
      "@": path.resolve(__dirname, "shell/src"),
    },
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/**/*.integration.ts", "node_modules", "dist", ".next"],
    coverage: {
      provider: "v8",
      include: ["packages/kernel/src/**", "packages/gateway/src/**"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.integration.ts"],
      thresholds: {
        statements: 99,
        branches: 95,
        functions: 99,
        lines: 99,
      },
    },
  },
});
