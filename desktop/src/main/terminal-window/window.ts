// Electron construction of the Terminal window. Kept thin: policy lives in
// the controller and the sender policy.
import { BrowserWindow, type Session } from "electron";
import type { FittedWindowBounds } from "../platform/window-bounds";
import { windowChromeOptions } from "../platform/window-chrome";
import { TERMINAL_WINDOW_ARG, TERMINAL_WINDOW_PARTITION } from "../../shared/terminal-window";

export interface TerminalBrowserWindowOptions {
  bounds: FittedWindowBounds;
  preloadPath: string;
  /** Exact trusted URL (dev server) or null to load the packaged file. */
  devUrl: string | null;
  packagedRendererPath: string;
  query: Record<string, string>;
  onLoadError(error: unknown): void;
}

/** The Terminal session grants no web permissions; clipboard goes through IPC. */
export function denyAllPermissions(session: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

export function createTerminalBrowserWindow(options: TerminalBrowserWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...options.bounds,
    ...windowChromeOptions(process.platform),
    title: "Terminal",
    backgroundColor: "#0e0e13",
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      partition: TERMINAL_WINDOW_PARTITION,
      additionalArguments: [TERMINAL_WINDOW_ARG],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  denyAllPermissions(win.webContents.session);
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The window is one trusted document; any navigation away is refused.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  if (options.devUrl) {
    void win.loadURL(options.devUrl).catch(options.onLoadError);
  } else {
    void win.loadFile(options.packagedRendererPath, { query: options.query }).catch(options.onLoadError);
  }
  return win;
}
