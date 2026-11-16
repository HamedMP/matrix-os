import type { BrowserWindowConstructorOptions } from "electron";

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

export const WINDOWS_TITLEBAR_HEIGHT = 38;

export function windowChromeOptions(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 14, y: 13 },
    };
  }

  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#fafafa",
        symbolColor: "#242323",
        height: WINDOWS_TITLEBAR_HEIGHT,
      },
    };
  }

  return { titleBarStyle: "default" };
}
