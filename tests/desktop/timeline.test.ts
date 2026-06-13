import { describe, expect, it } from "vitest";
import { describeEvent, relativeTime } from "@desktop/renderer/src/features/workspace/TimelinePanel";

const at = "2026-06-13T00:00:00.000Z";

describe("describeEvent", () => {
  it("labels session start, including the agent when present", () => {
    expect(describeEvent({ id: "1", type: "session.started", payload: { agent: "claude" }, createdAt: at })).toEqual({
      label: "Agent launched (claude)",
      color: "var(--success)",
    });
    expect(describeEvent({ id: "2", type: "session.started", createdAt: at }).label).toBe("Session started");
  });

  it("shows the new status on task.updated", () => {
    expect(describeEvent({ id: "3", type: "task.updated", payload: { status: "running" }, createdAt: at }).label).toBe(
      "Status → running",
    );
  });

  it("flags an unhealthy preview", () => {
    expect(describeEvent({ id: "4", type: "preview.updated", payload: { lastStatus: "failed" }, createdAt: at }).label).toBe(
      "Preview unhealthy",
    );
  });

  it("humanizes review events and unknown types", () => {
    expect(describeEvent({ id: "5", type: "review.completed", createdAt: at }).label).toBe("Review completed");
    expect(describeEvent({ id: "6", type: "diff.changed", createdAt: at }).label).toBe("diff changed");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-06-13T01:00:00.000Z");
  it("renders compact buckets", () => {
    expect(relativeTime("2026-06-13T00:59:30.000Z", now)).toBe("now");
    expect(relativeTime("2026-06-13T00:55:00.000Z", now)).toBe("5m");
    expect(relativeTime("2026-06-13T00:00:00.000Z", now)).toBe("1h");
    expect(relativeTime("2026-06-10T01:00:00.000Z", now)).toBe("3d");
  });
  it("returns empty for an unparseable timestamp", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});
