import { describe, expect, it } from "vitest";
import { desktopPlatform } from "../../desktop/src/renderer/src/lib/desktop-platform";
import { syncsNativeTitlebarOverlay, titlebarLayout } from "../../desktop/src/renderer/src/lib/titlebar-chrome";

describe("desktopPlatform", () => {
  it.each([
    ["MacIntel", "mac"],
    ["Win32", "windows"],
    ["Linux x86_64", "linux"],
    ["", "linux"],
  ] as const)("maps %j to %s", (platform, expected) => {
    expect(desktopPlatform(platform)).toBe(expected);
  });
});

describe("titlebarLayout", () => {
  it("reserves the left 96 px for the macOS traffic lights", () => {
    expect(titlebarLayout("mac")).toEqual({
      reservesLeftControls: true,
      gridTemplateColumns: "96px minmax(0, 1fr)",
      background: "color-mix(in srgb, var(--bg-sunken) 82%, transparent)",
    });
  });

  it.each(["windows", "linux"] as const)("starts %s tabs at the left edge", (platform) => {
    expect(titlebarLayout(platform)).toEqual({
      reservesLeftControls: false,
      gridTemplateColumns: "minmax(0, 1fr)",
      background: "var(--bg-sunken)",
    });
  });
});

describe("syncsNativeTitlebarOverlay", () => {
  it("syncs the Windows overlay from the main window only", () => {
    expect(syncsNativeTitlebarOverlay("windows", "")).toBe(true);
    expect(syncsNativeTitlebarOverlay("windows", "?window=terminal")).toBe(false);
  });

  it.each(["mac", "linux"] as const)("never syncs an overlay on %s", (platform) => {
    expect(syncsNativeTitlebarOverlay(platform, "")).toBe(false);
  });
});
