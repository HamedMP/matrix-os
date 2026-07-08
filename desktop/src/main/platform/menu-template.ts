import type { MenuItemConstructorOptions } from "electron";

type MenuEventSender = (channel: string, payload: unknown) => void;

interface AppMenuTemplateOptions {
  appName: string;
  codingAgentsWorkspace: boolean;
  isPackaged: boolean;
  openExternal(url: string): void;
  send: MenuEventSender;
}

export function createAppMenuTemplate({
  appName,
  codingAgentsWorkspace,
  isPackaged,
  openExternal,
  send,
}: AppMenuTemplateOptions): MenuItemConstructorOptions[] {
  const viewSubmenu: MenuItemConstructorOptions[] = [
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
    {
      label: "Terminal",
      accelerator: "Cmd+Alt+T",
      click: () => send("menu:navigate", { kind: "terminals" }),
    },
  ];

  if (codingAgentsWorkspace) {
    viewSubmenu.push({
      label: "Agents",
      accelerator: "Cmd+Shift+A",
      click: () => send("menu:navigate", { kind: "agents" }),
    });
  }

  viewSubmenu.push(
    { type: "separator" },
    { role: "togglefullscreen" },
    ...(isPackaged
      ? []
      : ([{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
  );

  return [
    {
      label: appName,
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
      submenu: viewSubmenu,
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Matrix OS Documentation",
          click: () => openExternal("https://matrix-os.com/docs"),
        },
      ],
    },
  ];
}
