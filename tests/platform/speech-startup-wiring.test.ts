import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("platform speech process wiring", () => {
  it("loads operator policy and composes the configured service before mounting routes", async () => {
    const source = await readFile("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toContain("createAiFundedReservationCleanupWorker({");
    expect(source).toContain("fundedReservationCleanupWorker?.shutdown()");
    expect(source).toContain("loadPlatformSpeechConfig(process.env)");
    expect(source).toContain("createConfiguredPlatformSpeechService({ db, config: speechConfig })");
    expect(source).not.toContain("const speechService: PlatformSpeechService = createUnavailablePlatformSpeechService");
  });

  it("starts funded reservation cleanup only with platform background workers and still drains it", async () => {
    const source = await readFile("packages/platform/src/platform-startup.ts", "utf8");
    expect(source).toMatch(
      /const fundedReservationCleanupWorker = backgroundWorkersEnabled\s*\? createAiFundedReservationCleanupWorker\(\{/,
    );
    const cleanupRegistration = source.slice(
      source.indexOf("registerCustomMcpStartupCleanup(async () => {", source.indexOf("const fundedReservationCleanupWorker")),
      source.indexOf("const appEnv", source.indexOf("const fundedReservationCleanupWorker")),
    );
    expect(cleanupRegistration).toContain("fundedReservationCleanupWorker?.shutdown()");
    expect(cleanupRegistration).toContain("customMcpShutdown?.()");
    const normalShutdown = source.slice(
      source.indexOf("await Promise.allSettled(["),
      source.indexOf("posthogProcessErrors.dispose()"),
    );
    expect(normalShutdown).toContain("fundedReservationCleanupWorker?.shutdown()");
  });
});
