import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.integration.ts", "node_modules", "dist", ".next"],
    coverage: {
      provider: "v8",
      include: ["packages/kernel/src/**", "packages/gateway/src/**"],
      exclude: ["**/*.test.ts", "**/*.integration.ts"],
      thresholds: {
        statements: 99,
        branches: 95,
        functions: 99,
        lines: 99,
      },
    },
  },
});
