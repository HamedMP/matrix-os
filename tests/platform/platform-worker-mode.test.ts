import { describe, expect, it } from "vitest";
import { shouldEnablePlatformBackgroundWorkers } from "../../packages/platform/src/platform-worker-mode.js";

describe("platform background worker mode", () => {
  it("requires an explicit opt-in on Cloud Run", () => {
    expect(shouldEnablePlatformBackgroundWorkers({ K_SERVICE: "matrix-platform" })).toBe(false);
    expect(shouldEnablePlatformBackgroundWorkers({ PLATFORM_RUNTIME_MODE: "cloud_run" })).toBe(false);
    expect(shouldEnablePlatformBackgroundWorkers({ K_SERVICE: "matrix-platform-worker", PLATFORM_BACKGROUND_WORKERS_ENABLED: "true" })).toBe(true);
  });

  it("preserves local platform workers unless explicitly disabled", () => {
    expect(shouldEnablePlatformBackgroundWorkers({})).toBe(true);
    expect(shouldEnablePlatformBackgroundWorkers({ PLATFORM_BACKGROUND_WORKERS_ENABLED: "false" })).toBe(false);
  });
});
