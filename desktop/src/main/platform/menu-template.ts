import type { MenuItemConstructorOptions } from "electron";
import type { EffectiveShortcuts, ShortcutActionId } from "@matrix-os/contracts/keyboard-shortcuts";
import type { ZoomAction } from "./zoom";

type MenuEventSender = (channel: string, payload: unknown) => void;
type ShortcutItemFactory = (id: ShortcutActionId, label: string) => MenuItemConstructorOptions;

const SWITCH_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** Bindings 2-4 stay out of the menu; the before-input-event matcher handles them. */
function createShortcutItem(
  shortcuts: EffectiveShortcuts,
  runShortcut: (id: ShortcutActionId) => void,
  id: ShortcutActionId,
  label: string,
): MenuItemConstructorOptions {
  const accelerator = shortcuts[id]?.[0];
  return { label, ...(accelerator ? { accelerator } : {}), click: () => runShortcut(id) };
}

function createAppsMenu(item: ShortcutItemFactory): MenuItemConstructorOptions {
  return {
    label: "Apps",
    submenu: [
      item("app.next", "Next App"),
      item("app.previous", "Previous App"),
      { type: "separator" },
      item("app.launcher", "Open App Launcher"),
      item("app.open-files", "Open Files"),
      { type: "separator" },
      item("app.minimize", "Minimize App"),
      item("app.toggle-full-size", "Toggle App Full Size"),
      item("app.show-desktop", "Show Desktop"),
      item("app.reopen", "Reopen Closed App"),
      { type: "separator" },
      {
        label: "Switch to App",
        submenu: SWITCH_NUMBERS.map((n) => item(`app.switch-${n}`, `App ${n}`)),
      },
    ],
  };
}

interface AppMenuTemplateOptions {
  appName: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  openExternal(url: string): void;
  send: MenuEventSender;
  adjustZoom(action: ZoomAction): void;
  checkForUpdates(): void;
  quitApp(): void;
  reloadWindow?(): void;
  /** Opens or focuses the native Terminal window (macOS and Linux only). */
  openTerminalWindow?(): void;
  /** Opens the licence texts of bundled third-party components, when this build ships any. */
  openThirdPartyNotices?(): void;
  /** Each registry action shows its first binding as its accelerator. */
  shortcuts: EffectiveShortcuts;
  runShortcut(id: ShortcutActionId): void;
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
  reloadWindow,
  openTerminalWindow,
  openThirdPartyNotices,
  shortcuts,
  runShortcut,
}: AppMenuTemplateOptions): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const item = (id: ShortcutActionId, label: string) => createShortcutItem(shortcuts, runShortcut, id, label);
  const viewSubmenu: MenuItemConstructorOptions[] = [
    item("nav.palette", "Command Palette"),
    item("nav.quick-open", "Go to File"),
    item("terminal.focus", "Terminal"),
    ...(openTerminalWindow && platform !== "win32"
      ? [{ ...item("terminal.window", "Terminal Window"), click: () => openTerminalWindow() }]
      : []),
    {
      label: "Reload",
      accelerator: "CmdOrCtrl+R",
      click: () => reloadWindow?.(),
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
  const settingsItem = item("nav.settings", "Settings…");
  const closeAppItem = item("app.close", "Close Selected App");
  const newItems: MenuItemConstructorOptions[] = [
    item("tabs.new-context", "New"),
    item("chat.new-thread", "New Agent Thread"),
    item("chat.open", "Open Chat"),
    { type: "separator" },
    item("tabs.new", "New Tab"),
    item("tabs.close", "Close Tab"),
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
            closeAppItem,
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
            closeAppItem,
            { label: "Exit", click: quitApp },
          ],
        },
      ];

  return [
    ...platformMenus,
    { role: "editMenu" },
    { label: "View", submenu: viewSubmenu },
    createAppsMenu(item),
    {
      // Built by hand: the windowMenu role's Minimize takes Cmd+M, which belongs to app.minimize.
      label: "Window",
      role: "window",
      submenu: [
        { label: "Minimize", click: (_menuItem, win) => win?.minimize() },
        ...(isMac
          ? ([{ role: "zoom" }, { type: "separator" }, { role: "front" }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Matrix OS Documentation",
          click: () => openExternal("https://matrix-os.com/docs"),
        },
        ...(openThirdPartyNotices ? [{ label: "Third-Party Notices", click: () => openThirdPartyNotices() }] : []),
      ],
    },
  ];
}
