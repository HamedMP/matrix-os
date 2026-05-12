import { describe, expect, it } from "vitest";
import {
  buildBrowserStandaloneAppUrl,
  normalizeBrowserRouteTarget,
} from "../../shell/src/lib/proxy-routes.js";

describe("standalone Browser route helpers", () => {
  it("normalizes target path segments into https URLs", () => {
    expect(normalizeBrowserRouteTarget(["google.com"])).toBe("https://google.com/");
    expect(normalizeBrowserRouteTarget(["example.com", "docs"])).toBe("https://example.com/docs");
    expect(normalizeBrowserRouteTarget(["https://example.com/path"])).toBe("https://example.com/path");
    expect(normalizeBrowserRouteTarget(undefined)).toBe("about:blank");
    expect(normalizeBrowserRouteTarget(["[::z]"])).toBe("about:blank");
  });

  it("builds an owner-hosted Browser app URL without proxying the target site", () => {
    expect(buildBrowserStandaloneAppUrl(["google.com"])).toBe(
      "/apps/browser/?target=https%3A%2F%2Fgoogle.com%2F&surface=standalone",
    );
  });
});
