import { app, BrowserWindow, ipcMain, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopLaunchPlan,
  createDesktopRuntimePolicy,
  loadDesktopWindowState,
  parseMatrixDesktopConfig,
  saveDesktopWindowState,
  type DesktopWindowState,
} from "./config.js";
import { createWindowOpenHandler, isAllowedShellNavigation } from "./security.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

app.enableSandbox();

const desktopConfig = parseMatrixDesktopConfig();
const desktopRuntimePolicy = createDesktopRuntimePolicy(desktopConfig);
const windowStatePath = () => join(app.getPath("userData"), "window-state.json");

function registerDesktopIpc(): void {
  ipcMain.handle("matrix-desktop:get-runtime-policy", () => desktopRuntimePolicy);
  ipcMain.handle("matrix-desktop:open-external", async (_event, url: unknown) => {
    if (typeof url !== "string") return { ok: false };
    const openWindow = createWindowOpenHandler({ openExternal: shell.openExternal });
    await openWindow({ url });
    return { ok: true };
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const windowState = await loadDesktopWindowState(windowStatePath());
  const launchPlan = createDesktopLaunchPlan(desktopConfig, windowState);
  const allowedShellOrigins = new Set(launchPlan.allowedOrigins);
  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Matrix Desktop",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, "../preload/index.js"),
    },
  });

  const windowOpenHandler = createWindowOpenHandler({ openExternal: shell.openExternal });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void windowOpenHandler({ url });
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedShellNavigation(url, allowedShellOrigins)) {
      event.preventDefault();
    }
  });

  win.once("ready-to-show", () => {
    if (windowState.maximized) {
      win.maximize();
    }
    win.show();
  });

  let windowStateSaved = false;
  win.on("close", (event) => {
    if (windowStateSaved) return;
    event.preventDefault();
    const bounds = win.getBounds();
    const nextState: DesktopWindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
      lastLoadedUrl: launchPlan.loadUrl,
    };
    void saveDesktopWindowState(windowStatePath(), nextState)
      .catch((err: unknown) => {
        console.warn("[desktop] Failed to save window state", err instanceof Error ? err.name : "UnknownError");
      })
      .finally(() => {
        windowStateSaved = true;
        win.close();
      });
  });

  void win.loadURL(launchPlan.loadUrl).catch((err: unknown) => {
    const failedState: DesktopWindowState = {
      width: windowState.width,
      height: windowState.height,
      x: windowState.x,
      y: windowState.y,
      maximized: windowState.maximized,
      lastLoadedUrl: launchPlan.loadUrl,
      lastFailureAt: new Date().toISOString(),
    };
    console.warn("[desktop] Failed to load Matrix shell", err instanceof Error ? err.name : "UnknownError");
    void saveDesktopWindowState(windowStatePath(), failedState);
  });
  return win;
}

registerDesktopIpc();

app.whenReady().then(() => {
  void createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
