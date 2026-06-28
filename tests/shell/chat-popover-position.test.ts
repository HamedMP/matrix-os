// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clampOffset,
  isDragged,
  loadOffset,
  saveOffset,
} from "../../shell/src/lib/chat-popover-position.js";

const VIEWPORT = { width: 1200, height: 800 };
const POPUP = { width: 380, height: 460 };

describe("clampOffset", () => {
  it("leaves an in-bounds offset untouched", () => {
    expect(clampOffset({ x: 40, y: -60 }, VIEWPORT, POPUP)).toEqual({ x: 40, y: -60 });
  });

  it("clamps a drag past the right edge", () => {
    // restLeft = 600 - 190 = 410; maxX = 1200 - 24 - 380 - 410 = 386
    expect(clampOffset({ x: 9999, y: 0 }, VIEWPORT, POPUP).x).toBe(386);
  });

  it("clamps a drag past the left edge", () => {
    // minX = 24 - 410 = -386
    expect(clampOffset({ x: -9999, y: 0 }, VIEWPORT, POPUP).x).toBe(-386);
  });

  it("clamps a drag above the top edge", () => {
    // restTop = 800 - 20 - 460 = 320; minY = 24 - 320 = -296
    expect(clampOffset({ x: 0, y: -9999 }, VIEWPORT, POPUP).y).toBe(-296);
  });

  it("snaps an axis home when the popup is larger than the viewport", () => {
    const tiny = { width: 200, height: 300 };
    expect(clampOffset({ x: 50, y: 50 }, tiny, POPUP)).toEqual({ x: 0, y: 0 });
  });
});

describe("offset persistence", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns zero when nothing is stored", () => {
    expect(loadOffset()).toEqual({ x: 0, y: 0 });
  });

  it("round-trips a saved offset", () => {
    saveOffset({ x: 120, y: -45 });
    expect(loadOffset()).toEqual({ x: 120, y: -45 });
  });

  it("falls back to zero on malformed json", () => {
    window.localStorage.setItem("matrix:chat-popover-offset", "{not json");
    expect(loadOffset()).toEqual({ x: 0, y: 0 });
  });

  it("ignores non-finite stored values", () => {
    window.localStorage.setItem(
      "matrix:chat-popover-offset",
      JSON.stringify({ x: "nope", y: null }),
    );
    expect(loadOffset()).toEqual({ x: 0, y: 0 });
  });
});

describe("isDragged", () => {
  it("is false at the origin and true once moved", () => {
    expect(isDragged({ x: 0, y: 0 })).toBe(false);
    expect(isDragged({ x: 1, y: 0 })).toBe(true);
  });
});
