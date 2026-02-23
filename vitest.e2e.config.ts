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
    include: ["tests/e2e/**/*.e2e.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
  },
});
