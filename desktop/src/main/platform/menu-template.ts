import type { MenuItemConstructorOptions } from "electron";
import type { EffectiveShortcuts, ShortcutActionId } from "@matrix-os/contracts/keyboard-shortcuts";
import { isCarriedByMatcher } from "../shortcuts/input-matcher";
import { isShortcutActionAvailable } from "../shortcuts/shortcut-availability";
import type { ZoomAction } from "./zoom";
import { terminalWindowKeys, type TerminalWindowCommand } from "../../shared/terminal-window";
import { terminalWindowMenuItems } from "./terminal-menu-items";

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
      ...item("app.tile-left", "Move App to Left Half"),
      ...item("app.tile-right", "Move App to Right Half"),
      ...item("app.tile-top", "Move App to Top Half"),
      ...item("app.tile-bottom", "Move App to Bottom Half"),
      ...item("app.restore-size", "Restore App Size"),
      { type: "separator" },
      {
        label: "Switch to App",
        submenu: SWITCH_NUMBERS.flatMap((n) => item(`app.switch-${n}`, `App ${n}`)),
      },
    ],
  };
}

export const STOP_BACKGROUND_MAC_CHECKS_MENU_ID = "stop-background-mac-checks";
export const RECENT_MAC_ACTIVITY_MENU_ID = "recent-mac-activity";

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
  stopBackgroundMacChecks?(): void;
  openMacActivity?(): void;
  openMacPairing?(): void;
  /** Opens the licence texts of bundled third-party components, when this build ships any. */
  openThirdPartyNotices?(): void;
  /** Each registry action shows its first binding as its accelerator. */
  shortcuts: EffectiveShortcuts;
  runShortcut(id: ShortcutActionId): void;
  /**
   * Set while the Terminal window has focus (spec 2706): File holds its
   * terminal shortcuts, and the main window's own shortcuts that would take
   * the same keys (View's navigation, the Apps menu) are left out.
   */
  terminalWindow?: { command(command: TerminalWindowCommand): void; close(): void };
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
  stopBackgroundMacChecks,
  openMacActivity,
  openMacPairing,
  openThirdPartyNotices,
  shortcuts,
  runShortcut,
  terminalWindow,
}: AppMenuTemplateOptions): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  // While the Terminal window has focus its own commands own their keys: a main-window item that
  // shares one (Settings on a key moved onto New Terminal) keeps its place without the key.
  const terminalKeys = terminalWindow ? terminalWindowKeys(shortcuts, isMac) : null;
  const menuShortcuts: EffectiveShortcuts = terminalKeys
    ? Object.fromEntries(Object.entries(shortcuts).map(([id, bindings]) => [
      id, id.startsWith("terminal-window.") ? bindings : bindings.filter((binding) => !terminalKeys.has(binding)),
    ])) as EffectiveShortcuts
    : shortcuts;
  const item: ShortcutItemFactory = (id, label) => createShortcutItems(menuShortcuts, () => runShortcut(id), id, label);
  const mainOnly = (items: MenuItemConstructorOptions[]) => (terminalWindow ? [] : items);
  const viewSubmenu: MenuItemConstructorOptions[] = [
    ...mainOnly([
      ...item("nav.palette", "Command Palette"),
      ...item("nav.quick-open", "Go to File"),
      ...item("terminal.focus", "Terminal"),
    ]),
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
  // Only the actions in the menu being built count: a Terminal window command on Cmd+Q holds it only there.
  const quitKeyFree = !Object.entries(shortcuts).some(([id, bindings]) =>
    (terminalWindow !== undefined || !id.startsWith("terminal-window.")) && bindings?.includes(quitKey));
  const quitAccelerator = quitKeyFree ? { accelerator: quitKey } : {};
  const settingsItems = item("nav.settings", "Settings…");
  const closeAppItems = item("app.close", "Close Selected App");
  const newItems: MenuItemConstructorOptions[] = terminalWindow
    ? terminalWindowMenuItems(shortcuts, terminalWindow.command, terminalWindow.close, isMac)
    : [
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
            ...(openMacPairing ? [{ label: "Mac Pairing…", click: openMacPairing }] : []),
            ...(openMacActivity ? [{
              id: RECENT_MAC_ACTIVITY_MENU_ID, label: "Recent Mac Activity…", enabled: false, click: openMacActivity,
            }] : []),
            ...(stopBackgroundMacChecks ? [{
              id: STOP_BACKGROUND_MAC_CHECKS_MENU_ID,
              label: "Stop Background Mac Terminal Checks",
              visible: false,
              click: stopBackgroundMacChecks,
            }] : []),
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
    ...mainOnly([createAppsMenu(item)]),
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
