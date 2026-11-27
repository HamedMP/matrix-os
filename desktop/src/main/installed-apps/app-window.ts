// Electron construction of one installed-app window. Kept thin: what the
// window shows is decided by the host. The window's own page is a static,
// script-free state page; the app runs in a child view created through the
// embedded-app path (same partition, preload, bridge and navigation policy).
import { BrowserWindow, nativeTheme, type AppShimHost, type WebContents } from "electron";
import type { FittedWindowBounds } from "../platform/window-bounds";
import { createInstalledAppHost, type InstalledAppHostOptions, type InstalledAppView } from "./app-host";
import type { InstalledAppRecord } from "./record";
import { installedAppStatePage } from "./state-page";
import type { NativeAppOpenTarget } from "../../shared/native-app-open";

/** In-memory session for the state page only; the app view uses its own app partition. */
export const INSTALLED_APP_STATE_PARTITION = "installed-app-state";

export interface InstalledAppBrowserWindowOptions extends Omit<InstalledAppHostOptions, "record" | "window" | "createView"> {
  record: InstalledAppRecord;
  bounds: FittedWindowBounds;
  /** macOS: the native window lives in this shim (fixed at creation; no parent, modal or titleBarOverlay). */
  appShim?: AppShimHost;
  /** Windows: the window's own AppUserModelID, icon and relaunch command (its own taskbar group). */
  appDetails?: Electron.AppDetailsOptions | undefined;
  createView(
    window: BrowserWindow,
    target: NativeAppOpenTarget,
    onState: (state: "loading" | "ready" | "failed") => void,
  ): Promise<InstalledAppView>;
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

function denyAllPermissions(contents: WebContents): void {
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

export function createInstalledAppBrowserWindow(options: InstalledAppBrowserWindowOptions) {
  const { record, bounds } = options;
  const win = new BrowserWindow({
    ...bounds,
    title: record.name,
    // App shim windows lack titleBarOverlay; keep the platform title bar everywhere.
    titleBarStyle: "default",
    ...(options.appShim ? { appShim: options.appShim } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e0e13" : "#fafafa",
    show: false,
    webPreferences: {
      partition: INSTALLED_APP_STATE_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      javascript: false,
      spellcheck: false,
      disableWakeLocks: true,
    },
  });
  if (options.appDetails && process.platform === "win32") win.setAppDetails(options.appDetails);
  const contents = win.webContents;
  denyAllPermissions(contents);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("page-title-updated", (event) => event.preventDefault());
  win.once("ready-to-show", () => win.show());

  const host = createInstalledAppHost({
    ...options,
    window: {
      setTitle: (title) => { if (!win.isDestroyed()) win.setTitle(title); },
      getContentSize: () => {
        const [width = 0, height = 0] = win.getContentSize();
        return [width, height];
      },
      showState: (kind, appName) => {
        void contents.loadURL(installedAppStatePage(kind, appName))
          .catch((error: unknown) => logFailure("state page failed to load", error));
      },
      close: () => { if (!win.isDestroyed()) win.close(); },
      isDestroyed: () => win.isDestroyed(),
    },
    createView: (target, onState) => options.createView(win, target, onState),
  });
  // The state page is one trusted document: every navigation is cancelled,
  // and only its exact action links do anything.
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    host.handleNavigation(event.url);
  });
  contents.on("will-redirect", (event) => event.preventDefault());
  win.on("resize", () => host.resize());
  return { window: win, host };
}
