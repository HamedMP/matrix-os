import type { BrowserWindowConstructorOptions } from "electron";

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

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
        color: "#0e0e13",
        symbolColor: "#f9f7f1",
        height: 38,
      },
    };
  }

  return { titleBarStyle: "default" };
}
