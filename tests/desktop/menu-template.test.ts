import { describe, expect, it, vi } from "vitest";
import { createAppMenuTemplate } from "../../desktop/src/main/platform/menu-template";

describe("createAppMenuTemplate", () => {
  it("adds a Terminal menu entry that navigates to the terminal workspace", () => {
    const send = vi.fn();
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      codingAgentsWorkspace: true,
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

  it("adds a gated Agents menu entry that navigates to the coding-agent workspace", () => {
    const send = vi.fn();
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      codingAgentsWorkspace: true,
      isPackaged: true,
      openExternal: vi.fn(),
      send,
    });

    const viewMenu = template.find((item) => item.label === "View");
    const agentsItem = Array.isArray(viewMenu?.submenu)
      ? viewMenu.submenu.find((item) => "label" in item && item.label === "Agents")
      : null;

    expect(agentsItem).toBeTruthy();
    expect(agentsItem && "accelerator" in agentsItem ? agentsItem.accelerator : null).toBe("Cmd+Alt+A");
    if (!agentsItem || !("click" in agentsItem) || typeof agentsItem.click !== "function") {
      throw new Error("Agents menu item is not clickable");
    }

    agentsItem.click({} as never, {} as never, {} as never);

    expect(send).toHaveBeenCalledWith("menu:navigate", { kind: "agents" });
  });

  it("omits the Agents menu entry when the desktop workspace flag is disabled", () => {
    const template = createAppMenuTemplate({
      appName: "Matrix OS",
      codingAgentsWorkspace: false,
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
