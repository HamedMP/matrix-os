import { describe, expect, it } from "vitest";
import {
  companionWindowBounds,
  companionWindowOptions,
  RABBIT_COLLAPSED_SIZE,
  RABBIT_EXPANDED_SIZE,
} from "../../desktop/src/main/companion/companion-window";

describe("desktop rabbit companion window", () => {
  it("anchors the collapsed rabbit inside the active display work area", () => {
    expect(companionWindowBounds(
      { x: 1200, y: 25, width: 1512, height: 957 },
      RABBIT_COLLAPSED_SIZE,
    )).toEqual({ x: 2596, y: 866, width: 96, height: 96 });
  });

  it("keeps the expanded composer pinned to the same bottom-right corner", () => {
    expect(companionWindowBounds(
      { x: 1200, y: 25, width: 1512, height: 957 },
      RABBIT_EXPANDED_SIZE,
    )).toEqual({ x: 2332, y: 794, width: 360, height: 168 });
  });

  it("creates a sandboxed macOS panel that stays above full-screen apps", () => {
    expect(companionWindowOptions("darwin", { x: 100, y: 200, width: 96, height: 96 }))
      .toMatchObject({
        x: 100,
        y: 200,
        width: 96,
        height: 96,
        type: "panel",
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
  });

  it("does not apply the macOS-only panel type on other platforms", () => {
    expect(companionWindowOptions("win32", { x: 0, y: 0, width: 96, height: 96 }))
      .not.toHaveProperty("type");
  });
});
