import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["node"],
    alias: {
      "@": path.resolve(__dirname, "shell/src"),
      "@matrix-os/kernel/security/external-content": path.resolve(__dirname, "packages/kernel/src/security/external-content.ts"),
      "@matrix-os/kernel/security/audit": path.resolve(__dirname, "packages/kernel/src/security/audit.ts"),
      "@matrix-os/kernel/security/ssrf-guard": path.resolve(__dirname, "packages/kernel/src/security/ssrf-guard.ts"),
      "@matrix-os/kernel/skill-registry": path.resolve(__dirname, "packages/kernel/src/skill-registry.ts"),
      "@matrix-os/kernel": path.resolve(__dirname, "packages/kernel/src/index.ts"),
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
