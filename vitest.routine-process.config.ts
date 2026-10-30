import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/gateway/bots/routine-process-postgres.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    env: { MATRIX_NO_TELEMETRY: "1" },
  },
});
