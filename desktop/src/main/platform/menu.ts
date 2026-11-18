// macOS application menu (US6): standard roles so copy/paste, window
// management, and full-screen behave like a first-class Mac app.
import { app, Menu, shell, type BrowserWindow } from "electron";
import { createMenuRouter } from "./menu-routing";
import { createAppMenuTemplate, RECENT_MAC_ACTIVITY_MENU_ID, STOP_BACKGROUND_MAC_CHECKS_MENU_ID } from "./menu-template";

export function installAppMenu(options: {
  mainWindow(): BrowserWindow | null;
  terminalWindow(): BrowserWindow | null;
  focusMain(): void;
  restoreMain(): void;
  checkForUpdates(): void;
  openTerminalWindow(): void;
  stopBackgroundMacChecks?(): void;
  openMacActivity?(): void;
  openMacPairing?(): void;
  /** The bundled notices file, or null when this build ships no third-party binary. */
  thirdPartyNoticesPath: string | null;
}) {
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
    stopBackgroundMacChecks: options.stopBackgroundMacChecks,
    openMacActivity: options.openMacActivity,
    openMacPairing: options.openMacPairing,
    ...(options.thirdPartyNoticesPath ? {
      openThirdPartyNotices: () => {
        // openPath resolves to an error string instead of rejecting.
        void shell.openPath(options.thirdPartyNoticesPath!).then((failure) => {
          if (failure) console.warn("[menu] could not open third-party notices");
        });
      },
    } : {}),
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return (active: boolean, hasActivityScope: boolean) => {
    const stop = menu.getMenuItemById(STOP_BACKGROUND_MAC_CHECKS_MENU_ID);
    if (stop) stop.visible = active;
    const activity = menu.getMenuItemById(RECENT_MAC_ACTIVITY_MENU_ID);
    if (activity) activity.enabled = hasActivityScope;
  };
}
