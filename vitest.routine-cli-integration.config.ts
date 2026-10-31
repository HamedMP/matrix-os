import { defineConfig } from "vitest/config";
import unit from "./vitest.config.js";
import integration from "./vitest.integration.config.js";

/** Source-built routine domain/native DB qualification; canonical transactions remain real. */
export default defineConfig({
  resolve: unit.resolve,
  test: {
    ...integration.test,
    env: { MATRIX_NO_TELEMETRY: "1" },
    include: ["tests/gateway/bots/routine-cli-*.postgres.integration.ts"],
  },
});
