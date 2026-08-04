// macOS application menu (US6): standard roles so copy/paste, window
// management, and full-screen behave like a first-class Mac app.
import { app, Menu, shell, type BrowserWindow } from "electron";
import { createAppMenuTemplate } from "./menu-template";
import { nextZoomFactor, type ZoomAction } from "./zoom";

export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload);
  };

  // Menu zoom steps apply immediately, then notify the renderer so its
  // appearance store can mirror and persist the new factor.
  const adjustZoom = (action: ZoomAction) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const factor = nextZoomFactor(win.webContents.getZoomFactor(), action);
    win.webContents.setZoomFactor(factor);
    send("app:zoom-changed", { factor });
  };

  const template = createAppMenuTemplate({
    appName: app.name,
    isPackaged: app.isPackaged,
    openExternal: (url) => {
      void shell.openExternal(url);
    },
    send,
    adjustZoom,
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
