import { describe, expect, it } from "vitest";
import { safeDisplayPath } from "../../packages/gateway/src/chat/safe-activity-projection.js";

describe("safeDisplayPath root normalization", () => {
  it("treats trailing separators on the home root as the same root", () => {
    expect(safeDisplayPath("/home/matrix/home/notes/a.md", { homePath: "/home/matrix/home//" })).toBe("~/notes/a.md");
    expect(safeDisplayPath("/home/matrix/home", { homePath: "/home/matrix/home\\/" })).toBe("~");
  });

  it("normalizes long separator runs in linear time", () => {
    const started = performance.now();
    safeDisplayPath("notes/a.md", { homePath: `/home${"/".repeat(100_000)}x` });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
