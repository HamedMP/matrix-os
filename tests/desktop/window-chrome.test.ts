import { describe, expect, it } from "vitest";
import { windowChromeOptions } from "../../desktop/src/main/platform/window-chrome";

describe("windowChromeOptions", () => {
  it("keeps native macOS traffic lights over the renderer title bar", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 14, y: 13 },
    });
  });

  it("uses Windows window controls overlay without macOS-only options", () => {
    expect(windowChromeOptions("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#0e0e13",
        symbolColor: "#f9f7f1",
        height: 38,
      },
    });
  });

  it("keeps Linux native window controls", () => {
    expect(windowChromeOptions("linux")).toEqual({ titleBarStyle: "default" });
  });
});
