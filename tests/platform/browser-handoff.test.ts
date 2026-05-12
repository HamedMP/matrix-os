import { describe, expect, it } from "vitest";
import {
  browserHandoffPathWithTargetQuery,
  buildBrowserHandoffRedirectUrl,
  normalizeBrowserHandoffTarget,
} from "../../packages/platform/src/browser-handoff.js";

describe("platform browser handoff", () => {
  it("preserves target query strings while excluding handoff control params", () => {
    const targetPath = browserHandoffPathWithTargetQuery(
      "/browser/https://example.com/search",
      "https://app.matrix-os.com/browser/https://example.com/search?q=matrix&deviceId=device_1",
    );

    expect(targetPath).toBe("/browser/https://example.com/search?q=matrix");
    expect(normalizeBrowserHandoffTarget(targetPath)).toBe("https://example.com/search?q=matrix");
  });

  it("redirects owner hosts with target query strings intact", () => {
    const redirect = buildBrowserHandoffRedirectUrl({
      machine: { publicIPv4: "203.0.113.10", status: "running" },
      targetPath: "/browser/https://example.com/search?q=matrix",
      token: "handoff_token",
    });

    expect(redirect).toBe("https://203.0.113.10/browser/https://example.com/search?q=matrix&handoff=handoff_token");
  });

  it("falls back to about:blank for malformed handoff targets", () => {
    expect(normalizeBrowserHandoffTarget("/browser/https://[bad")).toBe("about:blank");
  });
});
