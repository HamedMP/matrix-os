import { describe, expect, it } from "vitest";
import { chromiumBrowserLaunchArgs } from "../../packages/mcp-browser/src/media-service.js";

describe("Browser Chromium launch hardening", () => {
  it("uses deterministic basic password storage and keeps Chromium sandbox enabled", () => {
    const args = chromiumBrowserLaunchArgs();
    expect(args).toContain("--password-store=basic");
    expect(args).not.toContain("--no-sandbox");
  });
});
