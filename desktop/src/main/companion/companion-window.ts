import type { BrowserWindowConstructorOptions } from "electron";

export interface CompanionSize {
  width: number;
  height: number;
}

export interface CompanionWorkArea extends CompanionSize {
  x: number;
  y: number;
}

export interface CompanionBounds extends CompanionWorkArea {}

export const RABBIT_COLLAPSED_SIZE = { width: 96, height: 96 } as const;
export const RABBIT_EXPANDED_SIZE = { width: 360, height: 168 } as const;
export const COMPANION_WORK_AREA_INSET = 20;

export function companionWindowBounds(
  workArea: CompanionWorkArea,
  size: CompanionSize,
): CompanionBounds {
  return {
    x: workArea.x + workArea.width - size.width - COMPANION_WORK_AREA_INSET,
    y: workArea.y + workArea.height - size.height - COMPANION_WORK_AREA_INSET,
    width: size.width,
    height: size.height,
  };
}

export function companionWindowOptions(
  platform: NodeJS.Platform,
  bounds: CompanionBounds,
  preload?: string,
): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    ...(platform === "darwin" ? { type: "panel" as const } : {}),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    movable: true,
    webPreferences: {
      ...(preload ? { preload } : {}),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}
