import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveShortcuts } from "@matrix-os/contracts/keyboard-shortcuts";
import type { ShortcutSnapshot } from "@desktop/shared/shortcuts-ipc";

const electron = vi.hoisted(() => ({
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
}));
vi.mock("electron", () => ({
  app: { name: "Matrix OS", isPackaged: true, quit: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  Menu: { setApplicationMenu: electron.setApplicationMenu, buildFromTemplate: electron.buildFromTemplate },
}));

import { createMenuRouter } from "@desktop/main/platform/menu-routing";
import { createAppMenuTemplate } from "@desktop/main/platform/menu-template";
import { installAppMenu, runShortcut } from "@desktop/main/platform/menu";

const MAC_SHORTCUTS = resolveShortcuts(null, "mac");

function fakeWindow() {
  let zoom = 1;
  return {
    isDestroyed: () => false,
    isFocused: vi.fn(() => false),
    close: vi.fn(),
    minimize: vi.fn(),
    webContents: {
      send: vi.fn(), reload: vi.fn(),
      getZoomFactor: () => zoom, setZoomFactor: vi.fn((factor: number) => { zoom = factor; }),
    },
  };
}

function setup(terminalFocused: boolean) {
  const main = fakeWindow();
  const terminal = fakeWindow();
  terminal.isFocused.mockReturnValue(terminalFocused);
  const focusMain = vi.fn();
  const restoreMain = vi.fn();
  const router = createMenuRouter({ mainWindow: () => main, terminalWindow: () => terminal, focusMain, restoreMain });
  return { main, terminal, focusMain, restoreMain, router };
}

describe("application menu routing", () => {
  it("sends menu events to the main window when it has focus", () => {
    const { main, terminal, focusMain, router } = setup(false);
    router.send("shortcut:action", { id: "tabs.close" });
    router.adjustZoom("in");
    router.reload();
    expect(main.webContents.send).toHaveBeenCalledWith("shortcut:action", { id: "tabs.close" });
    expect(main.webContents.send).toHaveBeenCalledWith("app:zoom-changed", { factor: expect.any(Number) });
    expect(main.webContents.reload).toHaveBeenCalledTimes(1);
    expect(terminal.close).not.toHaveBeenCalled();
    expect(focusMain).not.toHaveBeenCalled();
  });

  it("closes, zooms and reloads the Terminal window itself when it has focus", () => {
    const { main, terminal, router } = setup(true);
    router.send("shortcut:action", { id: "tabs.close" });
    router.adjustZoom("in");
    router.reload();
    expect(terminal.close).toHaveBeenCalledTimes(1);
    expect(terminal.webContents.setZoomFactor).toHaveBeenCalledTimes(1);
    expect(terminal.webContents.reload).toHaveBeenCalledTimes(1);
    expect(terminal.webContents.send).not.toHaveBeenCalled();
    expect(main.webContents.send).not.toHaveBeenCalled();
    expect(main.webContents.reload).not.toHaveBeenCalled();
  });

  it("reopens a closed main window for a main-window action instead of silently dropping it", () => {
    const terminal = fakeWindow();
    terminal.isFocused.mockReturnValue(true);
    const restoreMain = vi.fn();
    const router = createMenuRouter({ mainWindow: () => null, terminalWindow: () => terminal, focusMain: vi.fn(), restoreMain });
    router.send("shortcut:action", { id: "nav.settings" });
    expect(restoreMain).toHaveBeenCalledTimes(1);
    // Closing the Terminal window itself still works without a main window.
    router.send("shortcut:action", { id: "tabs.close" });
    expect(terminal.close).toHaveBeenCalledTimes(1);
    expect(restoreMain).toHaveBeenCalledTimes(1);
  });

  it("brings the main window forward for main-window actions chosen from the Terminal window", () => {
    const { main, terminal, focusMain, router } = setup(true);
    router.send("shortcut:action", { id: "nav.palette" });
    expect(focusMain).toHaveBeenCalledTimes(1);
    expect(main.webContents.send).toHaveBeenCalledWith("shortcut:action", { id: "nav.palette" });
    expect(terminal.webContents.send).not.toHaveBeenCalled();
  });

  it("closes the focused Terminal window on the close-tab shortcut", () => {
    const { main, terminal, router } = setup(true);
    router.send("shortcut:action", { id: "tabs.close" });
    expect(terminal.close).toHaveBeenCalledTimes(1);
    expect(main.webContents.send).not.toHaveBeenCalled();
  });

  it("minimizes the focused Terminal window on the minimize shortcut", () => {
    const { main, terminal, focusMain, router } = setup(true);
    router.send("shortcut:action", { id: "app.minimize" });
    expect(terminal.minimize).toHaveBeenCalledTimes(1);
    expect(focusMain).not.toHaveBeenCalled();
    expect(main.webContents.send).not.toHaveBeenCalled();
    expect(main.minimize).not.toHaveBeenCalled();
  });

  it("sends the minimize shortcut to the main window when it has focus", () => {
    const { main, terminal, focusMain, router } = setup(false);
    router.send("shortcut:action", { id: "app.minimize" });
    expect(main.webContents.send).toHaveBeenCalledWith("shortcut:action", { id: "app.minimize" });
    expect(terminal.minimize).not.toHaveBeenCalled();
    expect(focusMain).not.toHaveBeenCalled();
  });

  it("brings the main window forward for other shortcuts chosen from the Terminal window", () => {
    const { main, terminal, focusMain, router } = setup(true);
    router.send("shortcut:action", { id: "app.next" });
    expect(terminal.close).not.toHaveBeenCalled();
    expect(focusMain).toHaveBeenCalledTimes(1);
    expect(main.webContents.send).toHaveBeenCalledWith("shortcut:action", { id: "app.next" });
  });

  it("restores a closed main window for a shortcut and sends nothing", () => {
    const terminal = fakeWindow();
    terminal.isFocused.mockReturnValue(true);
    const restoreMain = vi.fn();
    const router = createMenuRouter({ mainWindow: () => null, terminalWindow: () => terminal, focusMain: vi.fn(), restoreMain });
    router.send("shortcut:action", { id: "app.next" });
    expect(restoreMain).toHaveBeenCalledTimes(1);
    expect(terminal.webContents.send).not.toHaveBeenCalled();
    expect(terminal.close).not.toHaveBeenCalled();
  });

  it("does nothing when no window exists", () => {
    const router = createMenuRouter({ mainWindow: () => null, terminalWindow: () => null, focusMain: vi.fn(), restoreMain: vi.fn() });
    expect(() => { router.send("shortcut:action", { id: "nav.palette" }); router.adjustZoom("out"); router.reload(); }).not.toThrow();
  });
});

describe("Terminal window menu item", () => {
  it("opens the Terminal window from the View menu on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const openTerminalWindow = vi.fn();
      const runShortcut = vi.fn();
      const template = createAppMenuTemplate({ appName: "Matrix OS", isPackaged: true, platform, openExternal: vi.fn(),
        send: vi.fn(), adjustZoom: vi.fn(), checkForUpdates: vi.fn(), quitApp: vi.fn(), openTerminalWindow,
        shortcuts: resolveShortcuts(null, platform === "darwin" ? "mac" : "other"), runShortcut });
      const view = template.find((item) => item.label === "View")!.submenu as Array<{ label?: string; accelerator?: string; click?: () => void }>;
      const item = view.find((entry) => entry.label === "Terminal Window")!;
      expect(item.accelerator).toContain("Alt+Shift+T");
      item.click!();
      expect(openTerminalWindow).toHaveBeenCalledTimes(1);
      expect(runShortcut).not.toHaveBeenCalled();
    }
  });

  it("omits the item where the Terminal window is unsupported or unwired", () => {
    const options = { appName: "Matrix OS", isPackaged: true, openExternal: vi.fn(), send: vi.fn(), adjustZoom: vi.fn(),
      checkForUpdates: vi.fn(), quitApp: vi.fn(), shortcuts: MAC_SHORTCUTS, runShortcut: vi.fn() };
    for (const template of [
      createAppMenuTemplate({ ...options, platform: "win32", openTerminalWindow: vi.fn() }),
      createAppMenuTemplate({ ...options, platform: "darwin" }),
    ]) {
      const view = template.find((item) => item.label === "View")!.submenu as Array<{ label?: string }>;
      expect(view.some((entry) => entry.label === "Terminal Window")).toBe(false);
    }
  });
});

function fakeShortcutService() {
  let listener: ((snapshot: ShortcutSnapshot) => void) | null = null;
  const snapshot = (): ShortcutSnapshot => ({
    platform: "mac", overrides: { version: 1, overrides: {} }, effective: MAC_SHORTCUTS,
  });
  return {
    snapshot,
    onChange: vi.fn((next: (snapshot: ShortcutSnapshot) => void) => { listener = next; return () => { listener = null; }; }),
    emit(effective: ShortcutSnapshot["effective"]) { listener?.({ ...snapshot(), effective }); },
    hasListener: () => listener !== null,
  };
}

function installMenu(overrides: { terminalFocused?: boolean } = {}) {
  const main = fakeWindow();
  const terminal = fakeWindow();
  terminal.isFocused.mockReturnValue(overrides.terminalFocused ?? false);
  const shortcuts = fakeShortcutService();
  const openTerminalWindow = vi.fn();
  installAppMenu({
    mainWindow: () => main as never,
    terminalWindow: () => terminal as never,
    focusMain: vi.fn(),
    restoreMain: vi.fn(),
    checkForUpdates: vi.fn(),
    openTerminalWindow,
    thirdPartyNoticesPath: null,
    shortcuts: shortcuts as never,
  });
  return { main, terminal, shortcuts, openTerminalWindow };
}

type BuiltItem = { label?: string; accelerator?: string; submenu?: BuiltItem[]; click?: () => void };
function lastTemplate(): BuiltItem[] {
  const calls = electron.buildFromTemplate.mock.calls;
  return calls[calls.length - 1]![0] as BuiltItem[];
}

describe("runShortcut before the menu is installed", () => {
  it("warns instead of silently dropping the action", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fresh = await import("@desktop/main/platform/menu");
    fresh.runShortcut("app.next");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("installAppMenu", () => {
  beforeEach(() => {
    electron.setApplicationMenu.mockClear();
    electron.buildFromTemplate.mockClear();
  });

  it("rebuilds the menu when the shortcuts change", () => {
    const { shortcuts } = installMenu();
    expect(electron.setApplicationMenu).toHaveBeenCalledTimes(1);
    shortcuts.emit({ ...MAC_SHORTCUTS, "app.close": ["F6"] });
    expect(electron.setApplicationMenu).toHaveBeenCalledTimes(2);
    const walk = (items: BuiltItem[]): BuiltItem[] => items.flatMap((item) => [item, ...walk(item.submenu ?? [])]);
    expect(walk(lastTemplate()).find((item) => item.label === "Close Selected App")!.accelerator).toBe("F6");
  });

  it("stops following the previous service when installed again", () => {
    const first = installMenu();
    installMenu();
    expect(first.shortcuts.hasListener()).toBe(false);
  });

  it("delivers menu clicks and runShortcut through the same router", () => {
    const { main } = installMenu();
    const apps = lastTemplate().find((item) => item.label === "Apps")!;
    apps.submenu!.find((item) => item.label === "Next App")!.click!();
    runShortcut("app.next");
    expect(main.webContents.send.mock.calls).toEqual([
      ["shortcut:action", { id: "app.next" }],
      ["shortcut:action", { id: "app.next" }],
    ]);
  });

  it("routes runShortcut through the Terminal-window rules", () => {
    const { main, terminal } = installMenu({ terminalFocused: true });
    runShortcut("tabs.close");
    expect(terminal.close).toHaveBeenCalledTimes(1);
    expect(main.webContents.send).not.toHaveBeenCalled();
  });

  it("opens the Terminal window directly for its shortcut", () => {
    const { main, openTerminalWindow } = installMenu();
    runShortcut("terminal.window");
    expect(openTerminalWindow).toHaveBeenCalledTimes(1);
    expect(main.webContents.send).not.toHaveBeenCalled();
  });
});
