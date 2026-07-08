// macOS application menu (US6): standard roles so copy/paste, window
// management, and full-screen behave like a first-class Mac app.
import { app, Menu, shell, type BrowserWindow } from "electron";
import { resolveCodingAgentsDesktopWorkspaceFlag } from "./menu-feature-flags";
import { createAppMenuTemplate } from "./menu-template";

export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload);
  };

  const template = createAppMenuTemplate({
    appName: app.name,
    codingAgentsWorkspace: resolveCodingAgentsDesktopWorkspaceFlag(),
    isPackaged: app.isPackaged,
    openExternal: (url) => {
      void shell.openExternal(url);
    },
    send,
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
