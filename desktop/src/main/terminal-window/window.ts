// Electron construction of the Terminal window. Kept thin: policy lives in
// the controller and the sender policy.
import { BrowserWindow } from "electron";
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
  /** Exact URL the document must have to be trusted. */
  trustedUrl: string;
  onLoadError(error: unknown): void;
}

const CLIPBOARD_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write"]);

type PermissionDetails = { isMainFrame?: boolean; requestingUrl?: string };
interface PermissionSession {
  setPermissionCheckHandler(handler: (contents: unknown, permission: string, origin: string, details: PermissionDetails) => boolean): void;
  setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void, details: PermissionDetails) => void): void;
}

/**
 * The Terminal session grants exactly one thing: clipboard access to the
 * trusted Terminal document in its main frame (xterm copy and paste).
 * Everything else, and every other frame or URL, is denied.
 */
export function installTerminalWindowPermissions(
  session: PermissionSession,
  trustedContents: { getURL(): string },
  trustedUrl: string,
): void {
  const allowed = (contents: unknown, permission: string, details: PermissionDetails) =>
    CLIPBOARD_PERMISSIONS.has(permission) && contents === trustedContents && details.isMainFrame === true
    && details.requestingUrl === trustedUrl && trustedContents.getURL() === trustedUrl;
  session.setPermissionCheckHandler((contents, permission, _origin, details) => allowed(contents, permission, details));
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowed(contents, permission, details)));
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
  installTerminalWindowPermissions(win.webContents.session as unknown as PermissionSession, win.webContents, options.trustedUrl);
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
