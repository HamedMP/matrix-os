import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("process-level PostHog error entrypoints", () => {
  it("wires gateway and platform process errors to their shared PostHog trackers", async () => {
    const [gatewayMain, platformMain, platformStartup] = await Promise.all([
      readFile("packages/gateway/src/main.ts", "utf8"),
      readFile("packages/platform/src/main.ts", "utf8"),
      readFile("packages/platform/src/platform-startup.ts", "utf8"),
    ]);

    expect(gatewayMain).toContain("installPostHogProcessErrorTracking");
    expect(gatewayMain).toContain('service: "matrix-gateway"');
    expect(gatewayMain).toContain("resolveOwnerTelemetryDistinctId");

    expect(platformMain).toContain("await startPlatformServer(");
    expect(platformStartup).toContain("installPostHogProcessErrorTracking");
    expect(platformStartup).toContain("service: 'matrix-platform'");
    expect(platformStartup).toContain("posthogProcessErrors.dispose()");
  });
});
