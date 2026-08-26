import { describe, expect, it } from "vitest";

import { relativeSessionActivity } from "../../desktop/src/renderer/src/features/terminal/terminal-session-activity.js";

describe("relativeSessionActivity", () => {
  it("formats recent session activity consistently", () => {
    const now = Date.UTC(2026, 7, 26, 12, 0, 0);

    expect(relativeSessionActivity(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 minutes ago");
  });
});
