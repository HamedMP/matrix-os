import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalWindowController } from "@desktop/main/terminal-window/controller";

type Listener = () => void;
function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  let destroyed = false;
  let minimized = false;
  const win = {
    on: vi.fn((event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); }),
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: vi.fn(() => { minimized = false; }),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => { destroyed = true; win.emit("closed"); }),
    getBounds: vi.fn(() => ({ x: 10, y: 20, width: 900, height: 600 })),
    emit(event: string) { for (const listener of listeners.get(event) ?? []) listener(); },
    minimize() { minimized = true; },
  };
  return win;
}

describe("Terminal window controller", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function setup(overrides: { loadBounds?: () => Promise<unknown> } = {}) {
    const windows: Array<ReturnType<typeof fakeWindow>> = [];
    const create = vi.fn((_bounds: unknown) => { const win = fakeWindow(); windows.push(win); return win; });
    const saveBounds = vi.fn(async () => undefined);
    const controller = createTerminalWindowController({
      create,
      loadBounds: (overrides.loadBounds ?? (async () => null)) as never,
      saveBounds,
      fitBounds: (bounds) => ({ x: 0, y: 0, minWidth: 640, minHeight: 400, ...bounds }),
    });
    return { controller, create, saveBounds, windows };
  }

  it("creates one window for concurrent open requests", async () => {
    let release!: (value: null) => void;
    const { controller, create } = setup({ loadBounds: () => new Promise((resolve) => { release = resolve; }) });
    const first = controller.openOrFocus();
    const second = controller.openOrFocus();
    release(null);
    await Promise.all([first, second]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ width: 1100, height: 720 }));
  });

  it("focuses and restores the existing window instead of creating another", async () => {
    const { controller, create, windows } = setup();
    await controller.openOrFocus();
    windows[0]!.minimize();
    await controller.openOrFocus();
    expect(create).toHaveBeenCalledTimes(1);
    expect(windows[0]!.restore).toHaveBeenCalledTimes(1);
    expect(windows[0]!.focus).toHaveBeenCalled();
    expect(controller.current()).toBe(windows[0]);
  });

  it("reopens with saved bounds after the window is closed", async () => {
    const { controller, create, windows } = setup({ loadBounds: async () => ({ x: 5, y: 6, width: 800, height: 500 }) });
    await controller.openOrFocus();
    windows[0]!.close();
    expect(controller.current()).toBeNull();
    await controller.openOrFocus();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ x: 5, y: 6, width: 800, height: 500 }));
  });

  it("debounces bounds persistence and clears the timer when the window closes", async () => {
    const { controller, saveBounds, windows } = setup();
    await controller.openOrFocus();
    windows[0]!.emit("resize");
    windows[0]!.emit("move");
    expect(saveBounds).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(saveBounds).toHaveBeenCalledTimes(1);
    expect(saveBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 900, height: 600 });
    windows[0]!.emit("resize");
    windows[0]!.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(saveBounds).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to default bounds when saved bounds cannot be read", async () => {
    const { controller, create } = setup({ loadBounds: async () => { throw new Error("disk"); } });
    await controller.openOrFocus();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ width: 1100, height: 720 }));
  });

  it("closes the window on dispose and refuses to reopen", async () => {
    const { controller, windows } = setup();
    await controller.openOrFocus();
    controller.dispose();
    expect(windows[0]!.close).toHaveBeenCalled();
    await expect(controller.openOrFocus()).rejects.toThrow("Terminal window is unavailable");
  });
});
