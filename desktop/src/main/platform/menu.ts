// macOS application menu (US6): standard roles so copy/paste, window
// management, and full-screen behave like a first-class Mac app.
import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload);
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "Cmd+,",
          click: () => send("menu:navigate", { kind: "settings" }),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Task",
          accelerator: "Cmd+N",
          click: () => send("menu:action", { action: "new-task" }),
        },
        {
          label: "New Agent Thread",
          accelerator: "Cmd+J",
          click: () => send("menu:action", { action: "new-thread" }),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Command Palette",
          accelerator: "Cmd+K",
          click: () => send("menu:action", { action: "palette" }),
        },
        {
          label: "Go to File",
          accelerator: "Cmd+P",
          click: () => send("menu:action", { action: "quick-open" }),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged
          ? []
          : ([{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Matrix OS Documentation",
          click: () => {
            void shell.openExternal("https://matrix-os.com/docs");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
