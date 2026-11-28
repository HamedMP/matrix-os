// macOS application menu (US6): standard roles so copy/paste, window
// management, and full-screen behave like a first-class Mac app. Registry
// actions show their current shortcut bindings (specs/653).
import { app, Menu, shell, type BrowserWindow } from "electron";
import type { EffectiveShortcuts, ShortcutActionId } from "@matrix-os/contracts/keyboard-shortcuts";
import { isShortcutActionAvailable } from "../shortcuts/shortcut-availability";
import type { ShortcutService } from "../shortcuts/shortcut-service";
import { createMenuRouter } from "./menu-routing";
import { createAppMenuTemplate } from "./menu-template";
import type { TerminalWindowCommand } from "../../shared/terminal-window";

// The application menu is process-wide, and so is its shortcut runner.
let installedRunner: ((id: ShortcutActionId) => void) | null = null;
let stopFollowingShortcuts: (() => void) | null = null;

/**
 * Runs a shortcut action the way the application menu does, through the
 * menu router, so Terminal-window routing applies. Does nothing until
 * installAppMenu has run. The before-input-event matcher calls this.
 */
export function runShortcut(id: ShortcutActionId): void {
  if (!installedRunner) {
    console.warn("[menu] shortcut ignored: the application menu is not installed yet");
    return;
  }
  installedRunner(id);
}

export function installAppMenu(options: {
  mainWindow(): BrowserWindow | null;
  terminalWindow(): BrowserWindow | null;
  focusMain(): void;
  restoreMain(): void;
  checkForUpdates(): void;
  openTerminalWindow(): void;
  openDevicePairing?(): void;
  /** The bundled notices file, or null when this build ships no third-party binary. */
  thirdPartyNoticesPath: string | null;
  shortcuts: Pick<ShortcutService, "snapshot" | "onChange">;
  /** Delivers a Terminal window shortcut to that window (spec 2706). */
  sendTerminalCommand(command: TerminalWindowCommand): void;
}): { terminalWindowFocused(focused: boolean): void } {
  const router = createMenuRouter(options);
  const run = (id: ShortcutActionId): void => {
    if (id === "terminal.window") {
      if (isShortcutActionAvailable(id, process.platform)) options.openTerminalWindow();
      return;
    }
    router.send("shortcut:action", { id });
  };
  installedRunner = run;

  // Two menus per set of bindings: the Terminal window's shortcuts exist only while it has focus.
  let terminalFocused = false;
  let menus: { main: Menu; terminal: Menu } | null = null;
  let current: Menu | null = null;
  const show = (): void => {
    const next = menus ? (terminalFocused ? menus.terminal : menus.main) : null;
    if (!next || next === current) return;
    current = next;
    Menu.setApplicationMenu(next);
  };
  const template = (shortcuts: EffectiveShortcuts, terminal: boolean) => Menu.buildFromTemplate(createAppMenuTemplate({
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
    openDevicePairing: options.openDevicePairing,
    shortcuts,
    runShortcut: run,
    ...(options.thirdPartyNoticesPath ? {
      openThirdPartyNotices: () => {
        // openPath resolves to an error string instead of rejecting.
        void shell.openPath(options.thirdPartyNoticesPath!).then((failure) => {
          if (failure) console.warn("[menu] could not open third-party notices");
        });
      },
    } : {}),
    ...(terminal ? {
      terminalWindow: {
        command: options.sendTerminalCommand,
        close: () => options.terminalWindow()?.close(),
      },
    } : {}),
  }));
  const build = (shortcuts: EffectiveShortcuts): void => {
    const terminal = template(shortcuts, true);
    menus = { main: template(shortcuts, false), terminal };
    current = null;
    show();
  };

  build(options.shortcuts.snapshot().effective);
  stopFollowingShortcuts?.();
  stopFollowingShortcuts = options.shortcuts.onChange((snapshot) => build(snapshot.effective));
  return {
    terminalWindowFocused(focused) {
      terminalFocused = focused;
      show();
    },
  };
}
