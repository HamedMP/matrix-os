import { describe, expect, it, vi } from "vitest";
import { createMenuRouter } from "@desktop/main/platform/menu-routing";
import { createAppMenuTemplate } from "@desktop/main/platform/menu-template";

function fakeWindow() {
  let zoom = 1;
  return {
    isDestroyed: () => false,
    isFocused: vi.fn(() => false),
    close: vi.fn(),
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
  const router = createMenuRouter({ mainWindow: () => main, terminalWindow: () => terminal, focusMain });
  return { main, terminal, focusMain, router };
}

describe("application menu routing", () => {
  it("sends menu events to the main window when it has focus", () => {
    const { main, terminal, focusMain, router } = setup(false);
    router.send("menu:action", { action: "close-tab" });
    router.adjustZoom("in");
    router.reload();
    expect(main.webContents.send).toHaveBeenCalledWith("menu:action", { action: "close-tab" });
    expect(main.webContents.send).toHaveBeenCalledWith("app:zoom-changed", { factor: expect.any(Number) });
    expect(main.webContents.reload).toHaveBeenCalledTimes(1);
    expect(terminal.close).not.toHaveBeenCalled();
    expect(focusMain).not.toHaveBeenCalled();
  });

  it("closes, zooms and reloads the Terminal window itself when it has focus", () => {
    const { main, terminal, router } = setup(true);
    router.send("menu:action", { action: "close-tab" });
    router.adjustZoom("in");
    router.reload();
    expect(terminal.close).toHaveBeenCalledTimes(1);
    expect(terminal.webContents.setZoomFactor).toHaveBeenCalledTimes(1);
    expect(terminal.webContents.reload).toHaveBeenCalledTimes(1);
    expect(terminal.webContents.send).not.toHaveBeenCalled();
    expect(main.webContents.send).not.toHaveBeenCalled();
    expect(main.webContents.reload).not.toHaveBeenCalled();
  });

  it("brings the main window forward for main-window actions chosen from the Terminal window", () => {
    const { main, terminal, focusMain, router } = setup(true);
    router.send("menu:action", { action: "palette" });
    expect(focusMain).toHaveBeenCalledTimes(1);
    expect(main.webContents.send).toHaveBeenCalledWith("menu:action", { action: "palette" });
    expect(terminal.webContents.send).not.toHaveBeenCalled();
  });

  it("does nothing when no window exists", () => {
    const router = createMenuRouter({ mainWindow: () => null, terminalWindow: () => null, focusMain: vi.fn() });
    expect(() => { router.send("menu:action", { action: "palette" }); router.adjustZoom("out"); router.reload(); }).not.toThrow();
  });
});

describe("Terminal window menu item", () => {
  it("opens the Terminal window from the View menu on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const openTerminalWindow = vi.fn();
      const template = createAppMenuTemplate({ appName: "Matrix OS", isPackaged: true, platform, openExternal: vi.fn(),
        send: vi.fn(), adjustZoom: vi.fn(), checkForUpdates: vi.fn(), quitApp: vi.fn(), openTerminalWindow });
      const view = template.find((item) => item.label === "View")!.submenu as Array<{ label?: string; accelerator?: string; click?: () => void }>;
      const item = view.find((entry) => entry.label === "Terminal Window")!;
      expect(item.accelerator).toContain("Alt+Shift+T");
      item.click!();
      expect(openTerminalWindow).toHaveBeenCalledTimes(1);
    }
  });

  it("omits the item where the Terminal window is unsupported or unwired", () => {
    const options = { appName: "Matrix OS", isPackaged: true, openExternal: vi.fn(), send: vi.fn(), adjustZoom: vi.fn(),
      checkForUpdates: vi.fn(), quitApp: vi.fn() };
    for (const template of [
      createAppMenuTemplate({ ...options, platform: "win32", openTerminalWindow: vi.fn() }),
      createAppMenuTemplate({ ...options, platform: "darwin" }),
    ]) {
      const view = template.find((item) => item.label === "View")!.submenu as Array<{ label?: string }>;
      expect(view.some((entry) => entry.label === "Terminal Window")).toBe(false);
    }
  });
});
