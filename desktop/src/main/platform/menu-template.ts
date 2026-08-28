import type { MenuItemConstructorOptions } from "electron";
import type { ZoomAction } from "./zoom";

type MenuEventSender = (channel: string, payload: unknown) => void;

interface AppMenuTemplateOptions {
  appName: string;
  isPackaged: boolean;
  openExternal(url: string): void;
  send: MenuEventSender;
  adjustZoom(action: ZoomAction): void;
  checkForUpdates(): void;
  quitApp(): void;
}

export function createAppMenuTemplate({
  appName,
  isPackaged,
  openExternal,
  send,
  adjustZoom,
  checkForUpdates,
  quitApp,
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
    {
      label: "Refresh Home",
      accelerator: "CmdOrCtrl+R",
      click: () => send("menu:action", { action: "refresh-home" }),
    },
  ];

  viewSubmenu.push(
    { type: "separator" },
    // Custom click handlers instead of the zoomin/zoomout/resetzoom roles so
    // the factor round-trips through the shared zoom step path and the
    // renderer store hears about it via app:zoom-changed.
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
  );

  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates…",
          click: () => {
            send("update:manual-check-requested", {});
            checkForUpdates();
          },
        },
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
        {
          label: "Close Selected App",
          accelerator: "Cmd+Q",
          click: () => send("menu:action", { action: "close-app" }),
        },
        {
          label: `Quit ${appName}`,
          accelerator: "Cmd+Shift+Q",
          click: quitApp,
        },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Task",
          accelerator: "Cmd+N",
          click: () => send("menu:action", { action: "new-context" }),
        },
        {
          label: "New Agent Thread",
          accelerator: "Cmd+J",
          click: () => send("menu:action", { action: "new-thread" }),
        },
        { type: "separator" },
        {
          label: "New Tab",
          accelerator: "Cmd+T",
          click: () => send("menu:action", { action: "new-tab" }),
        },
        {
          label: "Close Tab",
          accelerator: "Cmd+W",
          click: () => send("menu:action", { action: "close-tab" }),
        },
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
