import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { resolveShortcuts, type EffectiveShortcuts } from "@matrix-os/contracts/keyboard-shortcuts";
import { createAppMenuTemplate } from "../../desktop/src/main/platform/menu-template";
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
      ["Apps", "Toggle App Full Size", undefined],
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
    expect(all).not.toContain("Cmd+Q");
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

  it("keeps Quit a plain item without an accelerator", () => {
    const opts = options();
    const appItems = submenu(createAppMenuTemplate(opts), "Matrix OS");
    expect(appItems.some((item) => item.role === "quit")).toBe(false);
    const quit = find(appItems, "Quit Matrix OS");
    expect(quit && "accelerator" in quit).toBe(false);
    click(quit);
    expect(opts.quitApp).toHaveBeenCalledOnce();
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
