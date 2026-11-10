import { isTerminalWindowLocation } from "../../../shared/terminal-window";
import type { DesktopPlatform } from "./desktop-platform";

export interface TitlebarLayout {
  reservesLeftControls: boolean;
  gridTemplateColumns: string;
  background: string;
}

const MAC_TRAFFIC_LIGHT_COLUMN = "96px";

// macOS draws traffic lights at the left over a hidden title bar. Windows
// draws caption buttons on the right, already excluded by the
// titlebar-area-* env() insets; Linux keeps its native frame.
export function titlebarLayout(platform: DesktopPlatform): TitlebarLayout {
  if (platform === "mac") {
    return {
      reservesLeftControls: true,
      gridTemplateColumns: `${MAC_TRAFFIC_LIGHT_COLUMN} minmax(0, 1fr)`,
      background: "color-mix(in srgb, var(--bg-sunken) 82%, transparent)",
    };
  }
  return { reservesLeftControls: false, gridTemplateColumns: "minmax(0, 1fr)", background: "var(--bg-sunken)" };
}

// Only the Windows main window owns a recolourable overlay; the sender
// policy refuses window:set-titlebar-overlay from the Terminal window.
export function syncsNativeTitlebarOverlay(platform: DesktopPlatform, search: string): boolean {
  return platform === "windows" && !isTerminalWindowLocation(search);
}
