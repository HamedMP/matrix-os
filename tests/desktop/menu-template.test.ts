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

  it("does not offer a retired Agents workspace entry", () => {
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      isPackaged: true,
      openExternal: vi.fn(),
      send: vi.fn(),
    });

    const viewMenu = template.find((item) => item.label === "View");
    const agentsItem = Array.isArray(viewMenu?.submenu)
      ? viewMenu.submenu.find((item) => "label" in item && item.label === "Agents")
      : null;

    expect(agentsItem).toBeUndefined();
  });
});
