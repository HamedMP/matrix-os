import { describe, expect, it } from "vitest";

import { relativeSessionActivity } from "../../desktop/src/renderer/src/features/terminal/terminal-session-activity.js";

describe("relativeSessionActivity", () => {
  it("does not fabricate a recent time for missing or invalid activity", () => {
    expect(relativeSessionActivity(undefined)).toBe("Activity unknown");
    expect(relativeSessionActivity("invalid")).toBe("Activity unknown");
  });
  it("formats recent session activity consistently", () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 0);

    expect(relativeSessionActivity(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 minutes ago");
  });
});
