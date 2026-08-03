import { describe, expect, it } from "vitest";

import { resolvePreviewVmRoute } from "../../packages/platform/src/preview-vm-route.js";

const previewEnv = {
  PLATFORM_PREVIEW: "true",
  PLATFORM_PREVIEW_ROUTE_MACHINE_ID: "610408b1-31d7-4e8b-b66b-309c3e622e47",
  PLATFORM_PREVIEW_ROUTE_HANDLE: "pr-1126",
  PLATFORM_PREVIEW_ROUTE_IPV4: "203.0.113.38",
  PLATFORM_PREVIEW_ROUTE_IMAGE_VERSION: "v2026.08.03-pr1126-518dead",
};

describe("preview VM route", () => {
  it("materializes only the configured disposable preview route", () => {
    expect(resolvePreviewVmRoute(previewEnv, "pr-1126", "pr-1126")).toMatchObject({
      machineId: "610408b1-31d7-4e8b-b66b-309c3e622e47",
      handle: "pr-1126",
      runtimeSlot: "pr-1126",
      provisioningClass: "preview",
      publicIPv4: "203.0.113.38",
      status: "running",
      imageVersion: "v2026.08.03-pr1126-518dead",
    });
    expect(resolvePreviewVmRoute(previewEnv, "pr-1127")).toBeNull();
    expect(resolvePreviewVmRoute(previewEnv, "pr-1126", "primary")).toBeNull();
  });

  it("stays disabled outside isolated preview mode or for invalid input", () => {
    expect(resolvePreviewVmRoute({ ...previewEnv, PLATFORM_PREVIEW: "false" }, "pr-1126")).toBeNull();
    expect(resolvePreviewVmRoute({ ...previewEnv, PLATFORM_PREVIEW_ROUTE_IPV4: "127.0.0.1" }, "pr-1126")).toBeNull();
    expect(resolvePreviewVmRoute({ ...previewEnv, PLATFORM_PREVIEW_ROUTE_HANDLE: "hamed" }, "hamed")).toBeNull();
  });
});
