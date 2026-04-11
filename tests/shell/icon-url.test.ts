import { describe, expect, it } from "vitest";
import { versionedIconUrl } from "../../shell/src/lib/icon-url.js";

describe("versionedIconUrl", () => {
  it("returns the original URL when no etag is present", () => {
    expect(versionedIconUrl("/icons/app.png")).toBe("/icons/app.png");
  });

  it("appends a sanitized version token when an etag is present", () => {
    expect(versionedIconUrl("/icons/app.png", "\"abc123\"")).toBe(
      "/icons/app.png?v=abc123",
    );
  });
});
