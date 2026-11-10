// macOS application menu (US6): standard roles so copy/paste, window
// management, and full-screen behave like a first-class Mac app.
import { app, Menu, shell, type BrowserWindow } from "electron";
import { createMenuRouter } from "./menu-routing";
import { createAppMenuTemplate } from "./menu-template";

export function installAppMenu(options: {
  mainWindow(): BrowserWindow | null;
  terminalWindow(): BrowserWindow | null;
  focusMain(): void;
  restoreMain(): void;
  checkForUpdates(): void;
  openTerminalWindow(): void;
}): void {
  const router = createMenuRouter(options);
  const template = createAppMenuTemplate({
    appName: app.name,
    isPackaged: app.isPackaged,
    platform: process.platform,
    openExternal: (url) => {
      void shell.openExternal(url);
    },
    send: router.send,
    adjustZoom: router.adjustZoom,
    checkForUpdates: options.checkForUpdates,
    quitApp: () => app.quit(),
    reloadWindow: router.reload,
    openTerminalWindow: options.openTerminalWindow,
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
