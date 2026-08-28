import { describe, expect, it, vi } from "vitest";
import { createAppMenuTemplate } from "../../desktop/src/main/platform/menu-template";

describe("createAppMenuTemplate", () => {
  it("offers Check for Updates in installed and development application menus", () => {
    for (const isPackaged of [true, false]) {
      const checkForUpdates = vi.fn();
      const send = vi.fn();
      const template = createAppMenuTemplate({
        appName: "Matrix OS",
        isPackaged,
        openExternal: vi.fn(),
        send,
        adjustZoom: vi.fn(),
        checkForUpdates,
        quitApp: vi.fn(),
      });
      const appMenu = template.find((item) => item.label === "Matrix OS");
      const updateItem = Array.isArray(appMenu?.submenu)
        ? appMenu.submenu.find((item) => "label" in item && item.label === "Check for Updates…")
        : null;

      expect(updateItem, `isPackaged=${isPackaged}`).toBeTruthy();
      if (!updateItem || !("click" in updateItem) || typeof updateItem.click !== "function") {
        throw new Error("Check for Updates menu item is not clickable");
      }
      updateItem.click({} as never, {} as never, {} as never);
      expect(send).toHaveBeenCalledWith("update:manual-check-requested", {});
      expect(checkForUpdates).toHaveBeenCalledOnce();
    }
  });

  it("maps Cmd+R to hosted Home refresh in packaged and development builds", () => {
    for (const isPackaged of [true, false]) {
      const send = vi.fn();
      const template = createAppMenuTemplate({
        appName: "Matrix OS",
        isPackaged,
        openExternal: vi.fn(),
        send,
        adjustZoom: vi.fn(),
        checkForUpdates: vi.fn(),
        quitApp: vi.fn(),
      });
      const viewMenu = template.find((item) => item.label === "View");
      const submenu = Array.isArray(viewMenu?.submenu) ? viewMenu.submenu : [];
      const refreshItem = submenu.find((item) => "label" in item && item.label === "Refresh Home");

      expect(refreshItem).toBeTruthy();
      expect(refreshItem && "accelerator" in refreshItem ? refreshItem.accelerator : null)
        .toBe("CmdOrCtrl+R");
      expect(submenu.some((item) => "role" in item && item.role === "reload")).toBe(false);
      if (!refreshItem || !("click" in refreshItem) || typeof refreshItem.click !== "function") {
        throw new Error("Refresh Home menu item is not clickable");
      }
      refreshItem.click({} as never, {} as never, {} as never);
      expect(send).toHaveBeenCalledWith("menu:action", { action: "refresh-home" });
    }
  });

  it("adds a Terminal menu entry that navigates to the terminal workspace", () => {
    const send = vi.fn();
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      isPackaged: true,
      openExternal: vi.fn(),
      send,
      adjustZoom: vi.fn(),
      checkForUpdates: vi.fn(),
      quitApp: vi.fn(),
    });

    const viewMenu = template.find((item) => item.label === "View");
    const terminalItem = Array.isArray(viewMenu?.submenu)
      ? viewMenu.submenu.find((item) => "label" in item && item.label === "Terminal")
      : null;

    expect(terminalItem).toBeTruthy();
    expect(terminalItem && "accelerator" in terminalItem ? terminalItem.accelerator : null).toBe("Cmd+Alt+T");
    if (!terminalItem || !("click" in terminalItem) || typeof terminalItem.click !== "function") {
      throw new Error("Terminal menu item is not clickable");
    }

    terminalItem.click({} as never, {} as never, {} as never);

    expect(send).toHaveBeenCalledWith("menu:navigate", { kind: "terminals" });
  });

  it("keeps the New Agent Thread menu entry that opens the project composer", () => {
    const send = vi.fn();
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      isPackaged: true,
      openExternal: vi.fn(),
      send,
      adjustZoom: vi.fn(),
      checkForUpdates: vi.fn(),
      quitApp: vi.fn(),
    });

    const fileMenu = template.find((item) => item.label === "File");
    const newThreadItem = Array.isArray(fileMenu?.submenu)
      ? fileMenu.submenu.find((item) => "label" in item && item.label === "New Agent Thread")
      : null;

    expect(newThreadItem).toBeTruthy();
    if (!newThreadItem || !("click" in newThreadItem) || typeof newThreadItem.click !== "function") {
      throw new Error("New Agent Thread menu item is not clickable");
    }

    newThreadItem.click({} as never, {} as never, {} as never);

    expect(send).toHaveBeenCalledWith("menu:action", { action: "new-thread" });
  });

  it("offers View-menu zoom items that route through the shared zoom path", () => {
    const adjustZoom = vi.fn();
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      isPackaged: true,
      openExternal: vi.fn(),
      send: vi.fn(),
      adjustZoom,
      checkForUpdates: vi.fn(),
      quitApp: vi.fn(),
    });

    const viewMenu = template.find((item) => item.label === "View");
    const submenu = Array.isArray(viewMenu?.submenu) ? viewMenu.submenu : [];
    const findItem = (label: string) =>
      submenu.find((item) => "label" in item && item.label === label);

    const cases = [
      { label: "Zoom In", accelerator: "CmdOrCtrl+=", action: "in" },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", action: "out" },
      { label: "Actual Size", accelerator: "CmdOrCtrl+0", action: "reset" },
    ] as const;

    for (const { label, accelerator, action } of cases) {
      const item = findItem(label);
      expect(item, label).toBeTruthy();
      expect(item && "accelerator" in item ? item.accelerator : null).toBe(accelerator);
      // Never the raw Electron zoom roles: clicks must round-trip through the
      // shared zoom step so the change is broadcast and persisted.
      expect(item && "role" in item ? item.role : null).toBeFalsy();
      if (!item || !("click" in item) || typeof item.click !== "function") {
        throw new Error(`${label} menu item is not clickable`);
      }
      item.click({} as never, {} as never, {} as never);
      expect(adjustZoom).toHaveBeenCalledWith(action);
    }
  });

  it("does not offer a retired Agents workspace entry", () => {
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      isPackaged: true,
      openExternal: vi.fn(),
      send: vi.fn(),
      adjustZoom: vi.fn(),
      checkForUpdates: vi.fn(),
      quitApp: vi.fn(),
    });

    const viewMenu = template.find((item) => item.label === "View");
    const agentsItem = Array.isArray(viewMenu?.submenu)
      ? viewMenu.submenu.find((item) => "label" in item && item.label === "Agents")
      : null;

    expect(agentsItem).toBeUndefined();
  });

  it("routes app and tab accelerators into Matrix OS instead of closing Electron", () => {
    const send = vi.fn();
    const quitApp = vi.fn();
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      isPackaged: true,
      openExternal: vi.fn(),
      send,
      adjustZoom: vi.fn(),
      checkForUpdates: vi.fn(),
      quitApp,
    });
    const appMenu = template.find((item) => item.label === "Matrix OS");
    const appItems = Array.isArray(appMenu?.submenu) ? appMenu.submenu : [];
    const fileMenu = template.find((item) => item.label === "File");
    const fileItems = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const cases = [
      { items: appItems, label: "Close Selected App", accelerator: "Cmd+Q", action: "close-app" },
      { items: fileItems, label: "New Tab", accelerator: "Cmd+T", action: "new-tab" },
      { items: fileItems, label: "Close Tab", accelerator: "Cmd+W", action: "close-tab" },
      { items: fileItems, label: "New", accelerator: "Cmd+N", action: "new-context" },
    ] as const;

    for (const { items, label, accelerator, action } of cases) {
      const item = items.find((candidate) => "label" in candidate && candidate.label === label);
      expect(item && "accelerator" in item ? item.accelerator : null).toBe(accelerator);
      if (!item || !("click" in item) || typeof item.click !== "function") {
        throw new Error(`${label} is not clickable`);
      }
      item.click({} as never, {} as never, {} as never);
      expect(send).toHaveBeenLastCalledWith("menu:action", { action });
    }

    expect(appItems.some((item) => "role" in item && item.role === "quit")).toBe(false);
    expect(fileItems.some((item) => "role" in item && item.role === "close")).toBe(false);
    const quitItem = appItems.find((item) => "label" in item && item.label === "Quit Matrix OS");
    expect(quitItem && "accelerator" in quitItem ? quitItem.accelerator : undefined).toBeUndefined();
    if (!quitItem || !("click" in quitItem) || typeof quitItem.click !== "function") {
      throw new Error("Quit Matrix OS is not clickable");
    }
    quitItem.click({} as never, {} as never, {} as never);
    expect(quitApp).toHaveBeenCalledOnce();
  });
});
