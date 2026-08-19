import { describe, expect, it } from "vitest";
import { safeReleaseNotesUrlTransform } from "@desktop/renderer/src/lib/markdown";

describe("release notes URL policy", () => {
  it("keeps HTTPS links and removes every other destination", () => {
    expect(safeReleaseNotesUrlTransform("https://matrix-os.com/releases/1.2.3")).toBe(
      "https://matrix-os.com/releases/1.2.3",
    );
    expect(safeReleaseNotesUrlTransform("http://example.com/release")).toBe("");
    expect(safeReleaseNotesUrlTransform("mailto:support@matrix-os.com")).toBe("");
    expect(safeReleaseNotesUrlTransform("./local-release.md")).toBe("");
  });
});
