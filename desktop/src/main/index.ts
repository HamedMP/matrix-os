import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";

function logMainError(label: string, err: unknown): void {
  console.warn(`[main] ${label}:`, err instanceof Error ? err.message : String(err));
}

// Single instance: second launches focus the existing window (FR-092).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 880,
      minHeight: 560,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 13 },
      backgroundColor: "#0e0e13",
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    win.once("ready-to-show", () => win.show());

    // All target=_blank / window.open from the renderer goes to the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) {
        void shell.openExternal(url).catch((err: unknown) => {
          logMainError("failed to open external URL", err);
        });
      }
      return { action: "deny" };
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL).catch((err: unknown) => {
        logMainError("failed to load renderer URL", err);
      });
    } else {
      void win.loadFile(join(__dirname, "../renderer/index.html")).catch((err: unknown) => {
        logMainError("failed to load renderer file", err);
      });
    }
    return win;
  }

  void app
    .whenReady()
    .then(() => {
      createWindow();

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((err: unknown) => {
      logMainError("failed to start app", err);
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
