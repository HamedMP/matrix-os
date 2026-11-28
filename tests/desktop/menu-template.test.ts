import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { resolveShortcuts, type EffectiveShortcuts } from "@matrix-os/contracts/keyboard-shortcuts";
import { isTerminalWindowKey, terminalWindowKeys } from "@desktop/shared/terminal-window";
import { createAppMenuTemplate } from "../../desktop/src/main/platform/menu-template";
import { terminalWindowMenuItems } from "../../desktop/src/main/platform/terminal-menu-items";
import { isShortcutActionAvailable } from "../../desktop/src/main/shortcuts/shortcut-availability";

type Platform = "darwin" | "linux" | "win32";

function options(overrides: Partial<Parameters<typeof createAppMenuTemplate>[0]> = {}) {
  const platform = (overrides.platform ?? "darwin") as Platform;
  return {
    appName: "Matrix OS",
    isPackaged: true,
    platform,
    openExternal: vi.fn(),
    send: vi.fn(),
    adjustZoom: vi.fn(),
    checkForUpdates: vi.fn(),
    quitApp: vi.fn(),
    shortcuts: resolveShortcuts(null, platform === "darwin" ? "mac" : "other"),
    runShortcut: vi.fn(),
    ...overrides,
  };
}

function submenu(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const menu = template.find((item) => item.label === label);
  return Array.isArray(menu?.submenu) ? menu.submenu : [];
}

function find(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined {
  return items.find((item) => item.label === label);
}

function click(item: MenuItemConstructorOptions | undefined): void {
  if (!item || typeof item.click !== "function") throw new Error(`${item?.label ?? "item"} is not clickable`);
  item.click({} as never, undefined, {} as never);
}

function walk(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? walk(item.submenu) : [])]);
}

function accelerators(template: MenuItemConstructorOptions[], platform: Platform): string[] {
  return walk(template)
    .map((item) => item.accelerator)
    .filter((accelerator): accelerator is string => typeof accelerator === "string")
    .map((accelerator) => accelerator.replace("CmdOrCtrl", platform === "darwin" ? "Cmd" : "Ctrl"));
}

describe("createAppMenuTemplate", () => {
  it("preserves Electron's standard non-terminal Edit menu roles", () => {
    expect(createAppMenuTemplate(options()).some((item) => item.role === "editMenu")).toBe(true);
  });

  it("offers Check for Updates in installed and development application menus", () => {
    for (const isPackaged of [true, false]) {
      const opts = options({ isPackaged });
      const updateItem = find(submenu(createAppMenuTemplate(opts), "Matrix OS"), "Check for Updates…");
      expect(updateItem, `isPackaged=${isPackaged}`).toBeTruthy();
      click(updateItem);
      expect(opts.send).toHaveBeenCalledWith("update:manual-check-requested", {});
      expect(opts.checkForUpdates).toHaveBeenCalledOnce();
    }
  });

  it("maps Cmd+R to a renderer reload in packaged and development builds", () => {
    for (const isPackaged of [true, false]) {
      const reloadWindow = vi.fn();
      const opts = options({ isPackaged, reloadWindow });
      const view = submenu(createAppMenuTemplate(opts), "View");
      const reload = find(view, "Reload");
      expect(reload?.accelerator).toBe("CmdOrCtrl+R");
      expect(view.some((item) => item.role === "reload")).toBe(false);
      click(reload);
      expect(reloadWindow).toHaveBeenCalledOnce();
      expect(opts.send).not.toHaveBeenCalled();
      expect(opts.runShortcut).not.toHaveBeenCalled();
    }
  });

  it("offers View-menu zoom items that route through the shared zoom path", () => {
    const opts = options();
    const view = submenu(createAppMenuTemplate(opts), "View");
    const cases = [
      { label: "Zoom In", accelerator: "CmdOrCtrl+=", action: "in" },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", action: "out" },
      { label: "Actual Size", accelerator: "CmdOrCtrl+0", action: "reset" },
    ] as const;
    for (const { label, accelerator, action } of cases) {
      const item = find(view, label);
      expect(item?.accelerator, label).toBe(accelerator);
      // Never the raw Electron zoom roles: clicks must round-trip through the
      // shared zoom step so the change is broadcast and persisted.
      expect(item?.role).toBeFalsy();
      click(item);
      expect(opts.adjustZoom).toHaveBeenCalledWith(action);
    }
  });

  it("does not offer a retired Agents workspace entry", () => {
    expect(find(submenu(createAppMenuTemplate(options()), "View"), "Agents")).toBeUndefined();
  });

  it("shows each action's first binding as its accelerator on macOS", () => {
    const template = createAppMenuTemplate(options());
    const expected: Array<[string, string, string | undefined]> = [
      ["Matrix OS", "Close Selected App", "Cmd+Q"],
      ["Matrix OS", "Settings…", "Cmd+,"],
      ["File", "New", "Cmd+N"],
      ["File", "New Tab", "Cmd+T"],
      ["File", "Close Tab", "Cmd+W"],
      ["File", "New Agent Thread", "Cmd+J"],
      ["File", "Open Chat", "Cmd+Shift+O"],
      ["View", "Command Palette", "Cmd+K"],
      ["View", "Go to File", "Cmd+P"],
      ["View", "Terminal", "Cmd+Alt+T"],
      ["Apps", "Next App", "Ctrl+Tab"],
      ["Apps", "Previous App", "Ctrl+Shift+Tab"],
      ["Apps", "Open App Launcher", "Alt+Space"],
      ["Apps", "Minimize App", "Cmd+M"],
      ["Apps", "Reopen Closed App", "Cmd+Shift+T"],
      ["Apps", "Show Desktop", undefined],
      ["Apps", "Toggle App Full Size", "Ctrl+Shift+Enter"],
      ["Apps", "Move App to Left Half", "Ctrl+Shift+Left"],
      ["Apps", "Move App to Right Half", "Ctrl+Shift+Right"],
      ["Apps", "Move App to Top Half", "Ctrl+Shift+Up"],
      ["Apps", "Move App to Bottom Half", "Ctrl+Shift+Down"],
      ["Apps", "Restore App Size", "Ctrl+Shift+Backspace"],
      ["Apps", "Open Files", undefined],
    ];
    for (const [menu, label, accelerator] of expected) {
      const item = find(submenu(template, menu), label);
      expect(item, `${menu} > ${label}`).toBeTruthy();
      expect(item?.accelerator, `${menu} > ${label}`).toBe(accelerator);
    }
    const switchMenu = find(submenu(template, "Apps"), "Switch to App");
    const switchItems = Array.isArray(switchMenu?.submenu) ? switchMenu.submenu : [];
    expect(switchItems.map((item) => item.accelerator)).toEqual(
      ["Cmd+1", "Cmd+2", "Cmd+3", "Cmd+4", "Cmd+5", "Cmd+6", "Cmd+7", "Cmd+8", "Cmd+9"],
    );
  });

  it("places the Apps menu right before Window", () => {
    const labels = createAppMenuTemplate(options()).map((item) => item.label ?? item.role);
    expect(labels.indexOf("Apps")).toBeGreaterThan(-1);
    expect(labels.indexOf("Apps")).toBe(labels.indexOf("Window") - 1);
  });

  it("uses only the first binding and shows custom bindings", () => {
    const shortcuts: EffectiveShortcuts = { ...resolveShortcuts(null, "mac"), "app.close": ["Cmd+Shift+W", "F6"] };
    const template = createAppMenuTemplate(options({ shortcuts }));
    expect(find(submenu(template, "Matrix OS"), "Close Selected App")?.accelerator).toBe("Cmd+Shift+W");
    const all = accelerators(template, "darwin");
    // The old default moves to Quit; no Close Selected App item keeps it.
    expect(all.filter((accelerator) => accelerator === "Cmd+Q")).toHaveLength(1);
    expect(find(submenu(template, "Matrix OS"), "Quit Matrix OS")?.accelerator).toBe("Cmd+Q");
    expect(all).not.toContain("F6");
  });

  it("adds hidden items for every later binding of an action outside the Apps group", () => {
    const shortcuts: EffectiveShortcuts = { ...resolveShortcuts(null, "mac"), "nav.palette": ["Cmd+K", "F6", "Ctrl+E"] };
    const opts = options({ shortcuts });
    const items = submenu(createAppMenuTemplate(opts), "View").filter((item) => item.label === "Command Palette");
    expect(items.map((item) => [item.accelerator, item.visible])).toEqual([
      ["Cmd+K", undefined], ["F6", false], ["Ctrl+E", false],
    ]);
    click(items[1]);
    expect(opts.runShortcut).toHaveBeenCalledWith("nav.palette");
  });

  it("adds hidden items only for control-chord later bindings of an Apps action", () => {
    const shortcuts: EffectiveShortcuts = { ...resolveShortcuts(null, "mac"), "app.close": ["Cmd+Q", "F6", "Ctrl+E"] };
    const template = createAppMenuTemplate(options({ shortcuts }));
    const items = submenu(template, "Matrix OS").filter((item) => item.label === "Close Selected App");
    expect(items.map((item) => [item.accelerator, item.visible])).toEqual([["Cmd+Q", undefined], ["Ctrl+E", false]]);
    expect(accelerators(template, "darwin")).not.toContain("F6");
  });

  it("adds hidden items for later bindings that are terminal control chords", () => {
    const shortcuts: EffectiveShortcuts = { ...resolveShortcuts(null, "other"), "app.close": ["Ctrl+Q", "Ctrl+E", "F6"] };
    const opts = options({ platform: "linux", shortcuts });
    const template = createAppMenuTemplate(opts);
    const closeItems = submenu(template, "File").filter((item) => item.label === "Close Selected App");
    expect(closeItems.map((item) => [item.accelerator, item.visible])).toEqual([["Ctrl+Q", undefined], ["Ctrl+E", false]]);
    click(closeItems[1]);
    expect(opts.runShortcut).toHaveBeenCalledWith("app.close");
    expect(accelerators(template, "linux")).not.toContain("F6");
  });

  it("keeps Ctrl+Space a menu accelerator: the matcher leaves it to the page", () => {
    const shortcuts: EffectiveShortcuts = { ...resolveShortcuts(null, "other"), "app.launcher": ["F6", "Ctrl+Space"] };
    const opts = options({ platform: "linux", shortcuts });
    const items = submenu(createAppMenuTemplate(opts), "Apps").filter((item) => item.label === "Open App Launcher");
    expect(items.map((item) => [item.accelerator, item.visible])).toEqual([["F6", undefined], ["Ctrl+Space", false]]);
    click(items[1]);
    expect(opts.runShortcut).toHaveBeenCalledWith("app.launcher");
  });

  it("omits the accelerator of an unbound action", () => {
    const shortcuts: EffectiveShortcuts = { ...resolveShortcuts(null, "mac"), "tabs.close": [] };
    const item = find(submenu(createAppMenuTemplate(options({ shortcuts })), "File"), "Close Tab");
    expect(item).toBeTruthy();
    expect(item && "accelerator" in item).toBe(false);
  });

  it("never gives two items the same accelerator", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const all = accelerators(createAppMenuTemplate(options({ platform, openTerminalWindow: vi.fn() })), platform);
      const duplicates = all.filter((accelerator, index) => all.indexOf(accelerator) !== index);
      expect(duplicates, platform).toEqual([]);
    }
  });

  it("runs registry actions through the shortcut runner instead of menu events", () => {
    const opts = options();
    const template = createAppMenuTemplate(opts);
    const cases: Array<[string, string, string]> = [
      ["Apps", "Next App", "app.next"],
      ["Apps", "Move App to Left Half", "app.tile-left"],
      ["Apps", "Move App to Right Half", "app.tile-right"],
      ["Apps", "Move App to Top Half", "app.tile-top"],
      ["Apps", "Move App to Bottom Half", "app.tile-bottom"],
      ["Apps", "Restore App Size", "app.restore-size"],
      ["Matrix OS", "Close Selected App", "app.close"],
      ["Matrix OS", "Settings…", "nav.settings"],
      ["File", "New Agent Thread", "chat.new-thread"],
      ["File", "Close Tab", "tabs.close"],
      ["View", "Terminal", "terminal.focus"],
    ];
    for (const [menu, label, id] of cases) {
      click(find(submenu(template, menu), label));
      expect(opts.runShortcut).toHaveBeenLastCalledWith(id);
    }
    const switchMenu = find(submenu(template, "Apps"), "Switch to App");
    click(Array.isArray(switchMenu?.submenu) ? switchMenu.submenu[2] : undefined);
    expect(opts.runShortcut).toHaveBeenLastCalledWith("app.switch-3");
    expect(opts.send).not.toHaveBeenCalled();
  });

  it("leaves Quit without an accelerator while Close Selected App holds Cmd+Q", () => {
    const opts = options();
    const appItems = submenu(createAppMenuTemplate(opts), "Matrix OS");
    expect(appItems.some((item) => item.role === "quit")).toBe(false);
    const quit = find(appItems, "Quit Matrix OS");
    expect(quit && "accelerator" in quit).toBe(false);
    click(quit);
    expect(opts.quitApp).toHaveBeenCalledOnce();
  });

  it("gives Quit Cmd+Q on macOS once no action is bound to it", () => {
    const shortcuts: EffectiveShortcuts = { ...resolveShortcuts(null, "mac"), "app.close": ["Cmd+Shift+W"] };
    const template = createAppMenuTemplate(options({ shortcuts }));
    expect(find(submenu(template, "Matrix OS"), "Quit Matrix OS")?.accelerator).toBe("Cmd+Q");
    const all = accelerators(template, "darwin");
    expect(all.filter((accelerator, index) => all.indexOf(accelerator) !== index)).toEqual([]);
  });

  it("gives Exit Ctrl+Q on Windows and Linux once no action is bound to it", () => {
    for (const platform of ["win32", "linux"] as const) {
      const shortcuts: EffectiveShortcuts = { ...resolveShortcuts(null, "other"), "app.close": [] };
      const template = createAppMenuTemplate(options({ platform, shortcuts, openTerminalWindow: vi.fn() }));
      expect(find(submenu(template, "File"), "Exit")?.accelerator, platform).toBe("Ctrl+Q");
      const all = accelerators(template, platform);
      expect(all.filter((accelerator, index) => all.indexOf(accelerator) !== index), platform).toEqual([]);
    }
  });

  it("builds the Window menu without the default Cmd+M minimize", () => {
    const template = createAppMenuTemplate(options());
    expect(template.some((item) => item.role === "windowMenu")).toBe(false);
    const windowItems = submenu(template, "Window");
    const minimize = find(windowItems, "Minimize");
    expect(minimize).toBeTruthy();
    expect(minimize && "accelerator" in minimize).toBe(false);
    expect(minimize?.role).toBeUndefined();
    expect(windowItems.some((item) => item.role === "zoom")).toBe(true);
    expect(windowItems.some((item) => item.role === "front")).toBe(true);
    const minimizeWindow = vi.fn();
    minimize!.click!({} as never, { minimize: minimizeWindow } as never, {} as never);
    expect(minimizeWindow).toHaveBeenCalledOnce();
    const linuxWindow = submenu(createAppMenuTemplate(options({ platform: "linux" })), "Window");
    expect(find(linuxWindow, "Minimize")).toBeTruthy();
    expect(linuxWindow.some((item) => item.role === "front")).toBe(false);
  });

  it("uses Windows conventions without macOS-only application roles", () => {
    const opts = options({ platform: "win32", openTerminalWindow: vi.fn() });
    const template = createAppMenuTemplate(opts);
    expect(template[0]?.label).toBe("File");
    expect(template.some((item) => item.label === "Matrix OS")).toBe(false);
    const serialized = JSON.stringify(template);
    for (const role of ["services", "hide", "hideOthers", "unhide"]) {
      expect(serialized).not.toContain(`"role":"${role}"`);
    }

    const fileItems = submenu(template, "File");
    const expectations = [
      ["New", "Ctrl+N"],
      ["New Agent Thread", "Ctrl+J"],
      ["New Tab", "Ctrl+T"],
      ["Close Tab", "Ctrl+W"],
      ["Settings…", "Ctrl+,"],
      ["Close Selected App", "Ctrl+Q"],
      ["Check for Updates…", undefined],
      ["Exit", undefined],
    ] as const;
    for (const [label, accelerator] of expectations) {
      const item = find(fileItems, label);
      expect(item, label).toBeTruthy();
      expect(item?.accelerator, label).toBe(accelerator);
    }
    expect(find(submenu(template, "View"), "Terminal")?.accelerator).toBe("Ctrl+Alt+T");
    expect(find(submenu(template, "View"), "Terminal Window")).toBeUndefined();
    expect(find(submenu(template, "Apps"), "Open App Launcher")?.accelerator).toBe("Ctrl+Space");
    expect(find(submenu(template, "Apps"), "Move App to Left Half")?.accelerator).toBe("Ctrl+Alt+Left");
    expect(find(submenu(template, "Apps"), "Restore App Size")?.accelerator).toBe("Ctrl+Alt+Backspace");

    click(find(fileItems, "Exit"));
    expect(opts.quitApp).toHaveBeenCalledOnce();
  });

  it("shows exactly the actions available on the platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const template = createAppMenuTemplate(options({ platform, openTerminalWindow: vi.fn() }));
      const hasTerminalWindow = walk(template).some((item) => item.label === "Terminal Window");
      expect(hasTerminalWindow, platform).toBe(isShortcutActionAvailable("terminal.window", platform));
      expect(isShortcutActionAvailable("app.next", platform)).toBe(true);
    }
  });

  it("lists third-party notices under Help only when the build ships them", () => {
    const help = (template: ReturnType<typeof createAppMenuTemplate>) =>
      template.find((item) => item.role === "help")!.submenu as Array<{ label?: string; click?: () => void }>;
    expect(help(createAppMenuTemplate(options())).map((item) => item.label)).toEqual(["Matrix OS Documentation"]);
    const openThirdPartyNotices = vi.fn();
    const withNotices = help(createAppMenuTemplate(options({ openThirdPartyNotices })));
    expect(withNotices.map((item) => item.label)).toEqual(["Matrix OS Documentation", "Third-Party Notices"]);
    withNotices[1]!.click!();
    expect(openThirdPartyNotices).toHaveBeenCalledTimes(1);
  });
});

// Spec 2706: Herdr's shortcuts exist only in the Terminal window's menu, and
// reach that window as commands; the main window keeps its own keys.
describe("Terminal window menu", () => {
  type Item = { label?: string; accelerator?: string; click?: () => void; submenu?: Item[]; visible?: boolean };
  const flat = (items: Item[]): Item[] => items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flat(item.submenu) : [])]);
  const build = (platform: NodeJS.Platform, terminal: boolean) => {
    const command = vi.fn();
    const close = vi.fn();
    const send = vi.fn();
    const template = createAppMenuTemplate({
      appName: "Matrix OS", isPackaged: true, platform, openExternal: vi.fn(), send, adjustZoom: vi.fn(),
      checkForUpdates: vi.fn(), quitApp: vi.fn(),
      shortcuts: resolveShortcuts(null, platform === "darwin" ? "mac" : "other"), runShortcut: vi.fn(),
      ...(terminal ? { terminalWindow: { command, close } } : {}),
    });
    return { items: flat(template as Item[]), command, close, send };
  };

  it("maps Herdr's keys to Terminal window commands", () => {
    const { items, command, close } = build("darwin", true);
    const byKey = (accelerator: string) => items.filter((item) => item.accelerator === accelerator);
    const expected: Array<[string, unknown]> = [
      ["Cmd+N", { command: "new-terminal" }], ["Cmd+T", { command: "new-terminal" }], ["Cmd+W", { command: "close-terminal" }],
      ["Cmd+Shift+P", { command: "picker" }], ["F2", { command: "rename" }],
      ["Cmd+F", { command: "find" }], ["Cmd+P", { command: "picker" }], ["Cmd+Shift+O", { command: "overview" }], ["Cmd+]", { command: "next" }],
      ["Cmd+[", { command: "previous" }], ["Ctrl+Tab", { command: "next-tab" }], ["Ctrl+Shift+Tab", { command: "previous-tab" }],
      ["Cmd+B", { command: "toggle-sidebar" }], ["Cmd+1", { command: "select", index: 1 }], ["Cmd+9", { command: "select", index: 9 }],
      ["Cmd+D", { command: "split-right" }], ["Cmd+Shift+D", { command: "split-down" }], ["Cmd+Shift+W", { command: "close-pane" }],
      ["Cmd+Shift+Enter", { command: "zoom-pane" }], ["Cmd+Alt+Left", { command: "focus-pane", direction: "left" }],
      ["Cmd+Alt+Down", { command: "focus-pane", direction: "down" }], ["Cmd+Alt+Shift+Right", { command: "swap-pane", direction: "right" }],
      ["Cmd+Alt+Shift+Up", { command: "swap-pane", direction: "up" }],
      ["Ctrl+0", { command: "space", index: 0 }], ["Ctrl+5", { command: "space", index: 5 }],
    ];
    for (const [accelerator, sent] of expected) {
      const matches = byKey(accelerator);
      expect(matches, accelerator).toHaveLength(1);
      matches[0]!.click!();
      expect(command, accelerator).toHaveBeenLastCalledWith(sent);
    }
    byKey("Cmd+Alt+W")[0]!.click!();
    expect(close).toHaveBeenCalled();
    // Main-window shortcuts that would collide are not in this menu, the Apps menu included.
    expect(items.some((item) => item.label === "Go to File" || item.label === "Command Palette" || item.label === "Next App")).toBe(false);
  });

  // Fault detected (Hamed, 2026-11-22): a focused terminal kept some of these keys, so the shortcut did nothing.
  it("reserves every menu shortcut from a focused terminal", () => {
    const shortcuts = resolveShortcuts(null, "mac");
    const keys = terminalWindowKeys(shortcuts, true);
    const items = flat(terminalWindowMenuItems(shortcuts, vi.fn(), vi.fn(), true) as Item[]);
    const arrows: Record<string, string> = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" };
    const accelerators = items.flatMap((item) => (item.accelerator ? [item.accelerator] : []));
    expect(accelerators.length).toBeGreaterThan(20);
    for (const accelerator of accelerators) {
      const parts = accelerator.split("+");
      const last = parts.at(-1)!;
      const event = {
        key: arrows[last] ?? last, code: "", metaKey: parts.includes("Cmd"), ctrlKey: parts.includes("Ctrl"),
        altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift"),
      };
      expect(isTerminalWindowKey(keys, event, true), accelerator).toBe(true);
    }
  });

  it("keeps the main window's menu free of Terminal window shortcuts", () => {
    const { items } = build("darwin", false);
    expect(items.some((item) => item.accelerator === "Cmd+B" || item.accelerator === "F2")).toBe(false);
    expect(items.find((item) => item.accelerator === "Cmd+P")?.label).toBe("Go to File");
    expect(items.find((item) => item.accelerator === "Ctrl+Tab")?.label).toBe("Next App");
  });

  it("leaves Ctrl alone to the shell on Linux", () => {
    const { items } = build("linux", true);
    expect(items.find((item) => item.label === "New Terminal")?.accelerator).toBe("Ctrl+Shift+N");
    expect(items.find((item) => item.label === "Split Right")?.accelerator).toBe("Ctrl+Shift+D");
    expect(items.some((item) => item.accelerator?.startsWith("Cmd+"))).toBe(false);
    expect(items.some((item) => item.accelerator === "Ctrl+W" || item.accelerator === "Ctrl+D")).toBe(false);
  });

  // ENG-521: the Terminal window's commands are registry actions, so a key set in Shortcuts settings
  // is the key its menu uses, and only while that window has focus.
  // Fault detected (Greptile, #3586): Cmd+, set on New Terminal also stayed on Settings in the Terminal
  // window's menu, so one key held two commands.
  it("leaves a key moved onto a Terminal window command off the main window's items there", () => {
    const shortcuts = { ...resolveShortcuts(null, "mac"), "terminal-window.new": ["Cmd+,"] };
    const command = vi.fn();
    const items = flat(createAppMenuTemplate({
      appName: "Matrix OS", isPackaged: true, platform: "darwin", openExternal: vi.fn(), send: vi.fn(), adjustZoom: vi.fn(),
      checkForUpdates: vi.fn(), quitApp: vi.fn(), shortcuts, runShortcut: vi.fn(), terminalWindow: { command, close: vi.fn() },
    }) as Item[]);
    const holders = items.filter((item) => item.accelerator === "Cmd+,");
    expect(holders.map((item) => item.label)).toEqual(["New Terminal"]);
    expect(items.find((item) => item.label === "Settings…")?.accelerator).toBeUndefined();
  });

  // Fault detected (Greptile, #3586): Cmd+Q set only on a Terminal window command took Quit's key in the main window too.
  it("keeps Quit's key in the main window when only a Terminal window command holds it", () => {
    const shortcuts = { ...resolveShortcuts(null, "mac"), "app.close": [], "terminal-window.close-window": ["Cmd+Q"] };
    const menu = (terminal: boolean) => flat(createAppMenuTemplate({
      appName: "Matrix OS", isPackaged: true, platform: "darwin", openExternal: vi.fn(), send: vi.fn(), adjustZoom: vi.fn(),
      checkForUpdates: vi.fn(), quitApp: vi.fn(), shortcuts, runShortcut: vi.fn(),
      ...(terminal ? { terminalWindow: { command: vi.fn(), close: vi.fn() } } : {}),
    }) as Item[]);
    expect(menu(false).find((item) => item.label === "Quit Matrix OS")?.accelerator).toBe("Cmd+Q");
    const terminal = menu(true);
    expect(terminal.find((item) => item.label === "Quit Matrix OS")?.accelerator).toBeUndefined();
    expect(terminal.filter((item) => item.accelerator === "Cmd+Q").map((item) => item.label)).toEqual(["Close Window"]);
  });

  it("takes each command's keys from the Shortcuts settings", () => {
    const command = vi.fn();
    const shortcuts = { ...resolveShortcuts(null, "mac"), "terminal-window.split-right": ["Cmd+Alt+D", "F7"], "terminal-window.overview": [] };
    const items = flat(terminalWindowMenuItems(shortcuts, command, vi.fn(), true) as Item[]);
    const splits = items.filter((item) => item.label === "Split Right");
    expect(splits.map((item) => [item.accelerator, item.visible])).toEqual([["Cmd+Alt+D", undefined], ["F7", false]]);
    splits[1]!.click!();
    expect(command).toHaveBeenCalledWith({ command: "split-right" });
    expect(items.find((item) => item.label === "Overview")?.accelerator).toBeUndefined();
    expect(items.some((item) => item.accelerator === "Cmd+D")).toBe(false);
  });
});
