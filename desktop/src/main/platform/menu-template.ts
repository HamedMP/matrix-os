import type { MenuItemConstructorOptions } from "electron";
import type { EffectiveShortcuts, ShortcutActionId } from "@matrix-os/contracts/keyboard-shortcuts";
import { isCarriedByMatcher } from "../shortcuts/input-matcher";
import { isShortcutActionAvailable } from "../shortcuts/shortcut-availability";
import type { ZoomAction } from "./zoom";

type MenuEventSender = (channel: string, payload: unknown) => void;
type ShortcutItemFactory = (id: ShortcutActionId, label: string) => MenuItemConstructorOptions[];

const SWITCH_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * The visible item carries the first binding. Bindings 2-4 that the
 * before-input-event matcher does not carry (every one outside the Apps group,
 * and terminal control chords) get hidden items so their accelerators work.
 */
function createShortcutItems(
  shortcuts: EffectiveShortcuts,
  click: () => void,
  id: ShortcutActionId,
  label: string,
): MenuItemConstructorOptions[] {
  const [first, ...rest] = shortcuts[id] ?? [];
  const hidden = rest
    .filter((binding) => !isCarriedByMatcher(id, binding))
    .map((accelerator): MenuItemConstructorOptions => ({ label, accelerator, visible: false, click }));
  return [{ label, ...(first ? { accelerator: first } : {}), click }, ...hidden];
}

function createAppsMenu(item: ShortcutItemFactory): MenuItemConstructorOptions {
  return {
    label: "Apps",
    submenu: [
      ...item("app.next", "Next App"),
      ...item("app.previous", "Previous App"),
      { type: "separator" },
      ...item("app.launcher", "Open App Launcher"),
      ...item("app.open-files", "Open Files"),
      { type: "separator" },
      ...item("app.minimize", "Minimize App"),
      ...item("app.toggle-full-size", "Toggle App Full Size"),
      ...item("app.show-desktop", "Show Desktop"),
      ...item("app.reopen", "Reopen Closed App"),
      { type: "separator" },
      {
        label: "Switch to App",
        submenu: SWITCH_NUMBERS.flatMap((n) => item(`app.switch-${n}`, `App ${n}`)),
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
  const item: ShortcutItemFactory = (id, label) => createShortcutItems(shortcuts, () => runShortcut(id), id, label);
  const viewSubmenu: MenuItemConstructorOptions[] = [
    ...item("nav.palette", "Command Palette"),
    ...item("nav.quick-open", "Go to File"),
    ...item("terminal.focus", "Terminal"),
    ...(openTerminalWindow && isShortcutActionAvailable("terminal.window", platform)
      ? createShortcutItems(shortcuts, () => openTerminalWindow(), "terminal.window", "Terminal Window")
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
  // Quit takes the platform's quit key back once no action claims it.
  const quitKey = isMac ? "Cmd+Q" : "Ctrl+Q";
  const quitKeyFree = !Object.values(shortcuts).some((bindings) => bindings?.includes(quitKey));
  const quitAccelerator = quitKeyFree ? { accelerator: quitKey } : {};
  const settingsItems = item("nav.settings", "Settings…");
  const closeAppItems = item("app.close", "Close Selected App");
  const newItems: MenuItemConstructorOptions[] = [
    ...item("tabs.new-context", "New"),
    ...item("chat.new-thread", "New Agent Thread"),
    ...item("chat.open", "Open Chat"),
    { type: "separator" },
    ...item("tabs.new", "New Tab"),
    ...item("tabs.close", "Close Tab"),
  ];

  const platformMenus: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: appName,
          submenu: [
            { role: "about" },
            updateItem,
            { type: "separator" },
            ...settingsItems,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            ...closeAppItems,
            { label: `Quit ${appName}`, ...quitAccelerator, click: quitApp },
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
            ...settingsItems,
            updateItem,
            { type: "separator" },
            ...closeAppItems,
            { label: "Exit", ...quitAccelerator, click: quitApp },
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
