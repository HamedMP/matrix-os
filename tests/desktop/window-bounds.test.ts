import { describe, expect, it } from "vitest";
import { fitWindowBoundsToWorkArea } from "../../desktop/src/main/platform/window-bounds";

describe("Desktop restored window bounds", () => {
  it("keeps a previously oversized window and its account avatar inside the current display", () => {
    expect(fitWindowBoundsToWorkArea(
      { x: 0, y: 0, width: 1512, height: 1512 },
      { x: 0, y: 25, width: 1512, height: 957 },
    )).toEqual({ x: 0, y: 25, width: 1512, height: 957 });
  });

  it("moves a restored window back from a disconnected display", () => {
    expect(fitWindowBoundsToWorkArea(
      { x: 1800, y: 80, width: 1280, height: 820 },
      { x: 0, y: 25, width: 1512, height: 957 },
    )).toEqual({ x: 232, y: 80, width: 1280, height: 820 });
  });
});
