import { describe, expect, it, vi } from "vitest";
import { createAppMenuTemplate } from "../../desktop/src/main/platform/menu-template";

describe("createAppMenuTemplate", () => {
  it("adds a Terminal menu entry that navigates to the terminal workspace", () => {
    const send = vi.fn();
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      isPackaged: true,
      openExternal: vi.fn(),
      send,
      adjustZoom: vi.fn(),
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
    });

    const viewMenu = template.find((item) => item.label === "View");
    const agentsItem = Array.isArray(viewMenu?.submenu)
      ? viewMenu.submenu.find((item) => "label" in item && item.label === "Agents")
      : null;

    expect(agentsItem).toBeUndefined();
  });
});
