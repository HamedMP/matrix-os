import type { MenuItemConstructorOptions } from "electron";
import type { ZoomAction } from "./zoom";

type MenuEventSender = (channel: string, payload: unknown) => void;

interface AppMenuTemplateOptions {
  appName: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  openExternal(url: string): void;
  send: MenuEventSender;
  adjustZoom(action: ZoomAction): void;
  checkForUpdates(): void;
  quitApp(): void;
}

export function createAppMenuTemplate({
  appName,
  isPackaged,
  platform = process.platform,
  openExternal,
  send,
  adjustZoom,
  checkForUpdates,
  quitApp,
}: AppMenuTemplateOptions): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const primary = (keys: string) => `${isMac ? "Cmd" : "CmdOrCtrl"}+${keys}`;
  const viewSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "Command Palette",
      accelerator: primary("K"),
      click: () => send("menu:action", { action: "palette" }),
    },
    {
      label: "Go to File",
      accelerator: primary("P"),
      click: () => send("menu:action", { action: "quick-open" }),
    },
    {
      label: "Terminal",
      accelerator: primary("Alt+T"),
      click: () => send("menu:navigate", { kind: "terminals" }),
    },
    {
      label: "Refresh Home",
      accelerator: "CmdOrCtrl+R",
      click: () => send("menu:action", { action: "refresh-home" }),
    },
    { type: "separator" },
    {
      label: "Zoom In",
      accelerator: "CmdOrCtrl+=",
      click: () => adjustZoom("in"),
    },
    {
      label: "Zoom Out",
      accelerator: "CmdOrCtrl+-",
      click: () => adjustZoom("out"),
    },
    {
      label: "Actual Size",
      accelerator: "CmdOrCtrl+0",
      click: () => adjustZoom("reset"),
    },
    { type: "separator" },
    { role: "togglefullscreen" },
    ...(isPackaged
      ? []
      : ([{ type: "separator" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
  ];

  const updateItem: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => {
      send("update:manual-check-requested", {});
      checkForUpdates();
    },
  };
  const settingsItem: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: primary(","),
    click: () => send("menu:navigate", { kind: "settings" }),
  };
  const newItems: MenuItemConstructorOptions[] = [
    {
      label: "New",
      accelerator: primary("N"),
      click: () => send("menu:action", { action: "new-context" }),
    },
    {
      label: "New Agent Thread",
      accelerator: primary("J"),
      click: () => send("menu:action", { action: "new-thread" }),
    },
    { type: "separator" },
    {
      label: "New Tab",
      accelerator: primary("T"),
      click: () => send("menu:action", { action: "new-tab" }),
    },
    {
      label: "Close Tab",
      accelerator: primary("W"),
      click: () => send("menu:action", { action: "close-tab" }),
    },
  ];

  const platformMenus: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: appName,
          submenu: [
            { role: "about" },
            updateItem,
            { type: "separator" },
            settingsItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            {
              label: "Close Selected App",
              accelerator: primary("Q"),
              click: () => send("menu:action", { action: "close-app" }),
            },
            { label: `Quit ${appName}`, click: quitApp },
          ],
        },
        { label: "File", submenu: newItems },
      ]
    : [
        {
          label: "File",
          submenu: [
            ...newItems,
            { type: "separator" },
            settingsItem,
            updateItem,
            { type: "separator" },
            {
              label: "Close Selected App",
              accelerator: primary("Q"),
              click: () => send("menu:action", { action: "close-app" }),
            },
            { label: "Exit", click: quitApp },
          ],
        },
      ];

  return [
    ...platformMenus,
    { role: "editMenu" },
    { label: "View", submenu: viewSubmenu },
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
