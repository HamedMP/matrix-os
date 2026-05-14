import { app, BrowserWindow, ipcMain, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopRuntimePolicy, parseMatrixDesktopConfig } from "./config.js";
import { createWindowOpenHandler, isAllowedShellNavigation } from "./security.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

app.enableSandbox();

const desktopConfig = parseMatrixDesktopConfig();
const desktopRuntimePolicy = createDesktopRuntimePolicy(desktopConfig);
const allowedShellOrigins = new Set([
  new URL(desktopConfig.shellUrl).origin,
  new URL(desktopConfig.gatewayUrl).origin,
]);

function registerDesktopIpc(): void {
  ipcMain.handle("matrix-desktop:get-runtime-policy", () => desktopRuntimePolicy);
  ipcMain.handle("matrix-desktop:open-external", async (_event, url: unknown) => {
    if (typeof url !== "string") return { ok: false };
    const openWindow = createWindowOpenHandler({ openExternal: shell.openExternal });
    await openWindow({ url });
    return { ok: true };
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
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
    win.show();
  });

  void win.loadURL(desktopConfig.shellUrl);
  return win;
}

registerDesktopIpc();

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
