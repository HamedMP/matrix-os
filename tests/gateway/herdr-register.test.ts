import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createHerdrSessionsFromEnv } from "../../packages/gateway/src/herdr/register.js";

describe("Herdr sessions gateway switch", () => {
  it("stays off unless MATRIX_HERDR=on", () => {
    expect(createHerdrSessionsFromEnv({})).toBeNull();
    expect(createHerdrSessionsFromEnv({ MATRIX_HERDR: "off" })).toBeNull();
    expect(createHerdrSessionsFromEnv({ MATRIX_HERDR: "1" })).toBeNull();
  });

  it("uses MATRIX_HERDR_CORE_BIN and reports a missing binary as not-installed", async () => {
    const exitListeners = process.listenerCount("exit");
    const adapter = createHerdrSessionsFromEnv({ MATRIX_HERDR: "on", MATRIX_HERDR_CORE_BIN: join(tmpdir(), "missing-herdr-core") });
    expect(adapter).not.toBeNull();
    expect(await adapter!.list()).toEqual({ available: false, status: "not-installed", sessions: [] });
    await adapter!.close();
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });
});
