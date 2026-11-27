import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstalledAppWindowController } from "@desktop/main/installed-apps/controller";
import type { InstalledAppRecord } from "@desktop/main/installed-apps/record";

type Listener = () => void;
function fakeWindow(bounds = { x: 10, y: 20, width: 900, height: 600 }) {
  const listeners = new Map<string, Listener[]>();
  let destroyed = false;
  let minimized = false;
  const win = {
    bounds,
    on: vi.fn((event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); }),
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: vi.fn(() => { minimized = false; }),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => {
      if (destroyed) return;
      win.emit("close");
      destroyed = true;
      win.emit("closed");
    }),
    getBounds: vi.fn(() => ({ ...win.bounds })),
    emit(event: string) { for (const listener of listeners.get(event) ?? []) listener(); },
    minimize() { minimized = true; },
    moveTo(x: number, y: number) { win.bounds = { ...win.bounds, x, y }; win.emit("move"); },
  };
  return win;
}

let counter = 0;
function record(overrides: Partial<InstalledAppRecord> = {}): InstalledAppRecord {
  counter += 1;
  const suffix = counter.toString(16).padStart(12, "0");
  return {
    installId: `6f1c2a4e-2b7d-4c1a-9f3e-${suffix}`,
    appIdentity: "notes", slug: "notes", runtimeSlot: "primary", name: "Notes",
    iconSha256: "a".repeat(64), bundlePath: null, cdHashes: [], createdAt: "2026-11-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("installed app window controller", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function setup(options: {
    records?: InstalledAppRecord[];
    getRecord?: (id: string) => Promise<InstalledAppRecord | null>;
    loadBounds?: (id: string) => Promise<unknown>;
    saveBounds?: (id: string, bounds: unknown) => Promise<void>;
    maxWindows?: number;
    createFails?: boolean;
  } = {}) {
    const records = new Map((options.records ?? []).map((item) => [item.installId, item]));
    const windows: Array<ReturnType<typeof fakeWindow>> = [];
    const created: Array<{ record: InstalledAppRecord; bounds: unknown; context: { appShim?: unknown } }> = [];
    const getRecord = vi.fn(options.getRecord ?? (async (id: string) => records.get(id) ?? null));
    const saveBounds = vi.fn(options.saveBounds ?? (async () => undefined));
    const controller = createInstalledAppWindowController({
      getRecord,
      create: (item, bounds, context) => {
        if (options.createFails) throw new Error("shim disconnected");
        created.push({ record: item, bounds, context });
        const win = fakeWindow();
        windows.push(win);
        return win;
      },
      loadBounds: (options.loadBounds ?? (async () => null)) as never,
      saveBounds,
      fitBounds: (bounds) => ({ x: 0, y: 0, minWidth: 480, minHeight: 320, ...bounds }),
      ...(options.maxWindows ? { maxWindows: options.maxWindows } : {}),
    });
    return { controller, windows, created, getRecord, saveBounds };
  }

  it("creates one window for concurrent opens of the same install", async () => {
    let release!: (value: InstalledAppRecord) => void;
    const item = record();
    const { controller, created } = setup({ getRecord: () => new Promise((resolve) => { release = resolve; }) });
    const first = controller.openOrFocus(item.installId);
    const second = controller.openOrFocus(item.installId);
    release(item);
    expect(await Promise.all([first, second])).toEqual(["opened", "opened"]);
    expect(created).toHaveLength(1);
    expect(created[0]!.record).toEqual(item);
    expect(created[0]!.bounds).toEqual(expect.objectContaining({ width: 1000, height: 720 }));
  });

  it("focuses and restores the open window instead of creating another", async () => {
    const item = record();
    const { controller, created, windows } = setup({ records: [item] });
    await controller.openOrFocus(item.installId);
    windows[0]!.minimize();
    expect(await controller.openOrFocus(item.installId)).toBe("focused");
    expect(created).toHaveLength(1);
    expect(windows[0]!.restore).toHaveBeenCalledOnce();
    expect(windows[0]!.focus).toHaveBeenCalled();
    expect(controller.current(item.installId)).toBe(windows[0]);
  });

  it("keeps one window per install, so two installs of one app open side by side", async () => {
    const first = record();
    const second = record();
    const { controller, windows } = setup({ records: [first, second] });
    await controller.openOrFocus(first.installId);
    await controller.openOrFocus(second.installId);
    expect(windows).toHaveLength(2);
    expect(controller.current(first.installId)).toBe(windows[0]);
    expect(controller.current(second.installId)).toBe(windows[1]);
  });

  it("opens nothing for unknown or malformed install ids", async () => {
    const { controller, created, getRecord } = setup();
    expect(await controller.openOrFocus("6f1c2a4e-2b7d-4c1a-9f3e-ffffffffffff")).toBe("not-installed");
    expect(await controller.openOrFocus("notes")).toBe("not-installed");
    expect(getRecord).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
  });

  it("reports unreadable records as unavailable, not as not installed", async () => {
    const { controller, created } = setup({ getRecord: async () => { throw new Error("Install records are unavailable"); } });
    expect(await controller.openOrFocus("6f1c2a4e-2b7d-4c1a-9f3e-ffffffffffff")).toBe("unavailable");
    expect(created).toHaveLength(0);
  });

  it("refuses past the open-window cap, counting opens still in flight, and frees a slot on close", async () => {
    const items = [record(), record(), record()];
    let release!: (value: InstalledAppRecord) => void;
    const { controller, windows } = setup({
      maxWindows: 2,
      getRecord: async (id) => {
        const item = items.find((candidate) => candidate.installId === id) ?? null;
        if (item === items[1]) return new Promise((resolve) => { release = resolve; });
        return item;
      },
    });
    expect(await controller.openOrFocus(items[0]!.installId)).toBe("opened");
    const pending = controller.openOrFocus(items[1]!.installId);
    expect(await controller.openOrFocus(items[2]!.installId)).toBe("limit");
    release(items[1]!);
    expect(await pending).toBe("opened");
    windows[0]!.close();
    expect(await controller.openOrFocus(items[2]!.installId)).toBe("opened");
  });

  it("restores the window state saved for that install", async () => {
    const item = record();
    const loadBounds = vi.fn(async () => ({ x: 40, y: 50, width: 700, height: 500 }));
    const { controller, created } = setup({ records: [item], loadBounds });
    await controller.openOrFocus(item.installId);
    expect(loadBounds).toHaveBeenCalledWith(item.installId);
    expect(created[0]!.bounds).toEqual({ x: 40, y: 50, width: 700, height: 500, minWidth: 480, minHeight: 320 });
  });

  it("falls back to default bounds when saved state cannot be read", async () => {
    const item = record();
    const { controller, created } = setup({ records: [item], loadBounds: async () => { throw new Error("disk"); } });
    expect(await controller.openOrFocus(item.installId)).toBe("opened");
    expect(created[0]!.bounds).toEqual(expect.objectContaining({ width: 1000, height: 720 }));
  });

  it("debounces window-state saves to one write of the latest bounds after 500 ms", async () => {
    const item = record();
    const { controller, windows, saveBounds } = setup({ records: [item] });
    await controller.openOrFocus(item.installId);
    windows[0]!.moveTo(100, 100);
    vi.advanceTimersByTime(300);
    windows[0]!.moveTo(200, 150);
    vi.advanceTimersByTime(499);
    expect(saveBounds).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(saveBounds).toHaveBeenCalledOnce();
    expect(saveBounds).toHaveBeenCalledWith(item.installId, { x: 200, y: 150, width: 900, height: 600 });
  });

  it("saves the window state once when the window closes, replacing a pending debounced save", async () => {
    const item = record();
    const { controller, windows, saveBounds } = setup({ records: [item] });
    await controller.openOrFocus(item.installId);
    windows[0]!.moveTo(300, 120);
    windows[0]!.close();
    expect(saveBounds).toHaveBeenCalledWith(item.installId, { x: 300, y: 120, width: 900, height: 600 });
    vi.advanceTimersByTime(1_000);
    expect(saveBounds).toHaveBeenCalledOnce();
    expect(controller.current(item.installId)).toBeNull();
  });

  it("closes every window, waits for state saves, and refuses opens after dispose", async () => {
    const items = [record(), record()];
    let finishSave!: () => void;
    const saved = new Promise<void>((resolve) => { finishSave = resolve; });
    const { controller, windows, saveBounds } = setup({ records: items, saveBounds: () => saved });
    await controller.openOrFocus(items[0]!.installId);
    await controller.openOrFocus(items[1]!.installId);
    windows[0]!.moveTo(5, 5);
    let drained = false;
    const drain = controller.dispose().then(() => { drained = true; });
    expect(windows.every((win) => win.close.mock.calls.length === 1)).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    finishSave();
    await drain;
    expect(drained).toBe(true);
    expect(saveBounds).toHaveBeenCalledTimes(2);
    expect(await controller.openOrFocus(items[0]!.installId)).toBe("unavailable");
  });

  it("does not create a window for an open that settles after dispose", async () => {
    const item = record();
    let release!: (value: InstalledAppRecord) => void;
    const { controller, created } = setup({ getRecord: () => new Promise((resolve) => { release = resolve; }) });
    const pending = controller.openOrFocus(item.installId);
    void controller.dispose();
    release(item);
    expect(await pending).toBe("unavailable");
    expect(created).toHaveLength(0);
  });

  it("closes the windows a predicate selects and keeps the others", async () => {
    const items = [record(), record()];
    const { controller, windows } = setup({ records: items });
    await controller.openOrFocus(items[0]!.installId);
    await controller.openOrFocus(items[1]!.installId);
    controller.closeWhere((installId) => installId === items[0]!.installId);
    expect(windows[0]!.close).toHaveBeenCalledOnce();
    expect(windows[1]!.close).not.toHaveBeenCalled();
    expect(controller.openCount()).toBe(1);
  });

  describe("app shims", () => {
    const shim = { id: "shim-a" };

    it("creates the window inside the shim that asked for it, and focuses it there afterwards", async () => {
      const item = record();
      const { controller, created } = setup({ records: [item] });
      expect(await controller.openOrFocus(item.installId, { appShim: shim })).toBe("opened");
      expect(created[0]!.context.appShim).toBe(shim);
      expect(controller.shimOf(item.installId)).toBe(shim);
      expect(await controller.openOrFocus(item.installId, { appShim: shim })).toBe("focused");
      expect(created).toHaveLength(1);
    });

    it("moves a plain window into a shim: its state is saved, it closes, and the shim gets a new one", async () => {
      const item = record();
      const { controller, windows, created, saveBounds } = setup({ records: [item] });
      await controller.openOrFocus(item.installId);
      windows[0]!.moveTo(300, 200);
      expect(await controller.openOrFocus(item.installId, { appShim: shim })).toBe("opened");
      expect(windows[0]!.close).toHaveBeenCalledOnce();
      expect(saveBounds).toHaveBeenCalledWith(item.installId, { x: 300, y: 200, width: 900, height: 600 });
      expect(created[1]!.context.appShim).toBe(shim);
      expect(controller.openCount()).toBe(1);
      expect(controller.current(item.installId)).toBe(windows[1]);
      vi.advanceTimersByTime(1000);
      expect(saveBounds).toHaveBeenCalledTimes(1);
    });

    it("focuses a shim's window for a plain open instead of taking it out of the shim", async () => {
      const item = record();
      const { controller, created, windows } = setup({ records: [item] });
      await controller.openOrFocus(item.installId, { appShim: shim });
      expect(await controller.openOrFocus(item.installId)).toBe("focused");
      expect(created).toHaveLength(1);
      expect(windows[0]!.focus).toHaveBeenCalled();
    });

    it("lets a plain creation in flight finish, then moves it into the shim", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const item = record();
      const { controller, created } = setup({ getRecord: async () => { await gate; return item; } });
      const plain = controller.openOrFocus(item.installId);
      const inShim = controller.openOrFocus(item.installId, { appShim: shim });
      release();
      expect(await plain).toBe("opened");
      expect(await inShim).toBe("opened");
      expect(created.map((entry) => entry.context.appShim)).toEqual([undefined, shim]);
    });

    it("reports unavailable when the window cannot be created", async () => {
      const item = record();
      const { controller } = setup({ records: [item], createFails: true });
      expect(await controller.openOrFocus(item.installId, { appShim: shim })).toBe("unavailable");
      expect(controller.openCount()).toBe(0);
    });

    it("saves a window's state at once, for a shim that quits without close events", async () => {
      const item = record();
      const { controller, windows, saveBounds } = setup({ records: [item] });
      await controller.openOrFocus(item.installId, { appShim: shim });
      windows[0]!.moveTo(40, 50);
      controller.saveNow(item.installId);
      expect(saveBounds).toHaveBeenCalledWith(item.installId, { x: 40, y: 50, width: 900, height: 600 });
      vi.advanceTimersByTime(1000);
      expect(saveBounds).toHaveBeenCalledTimes(1);
    });
  });
});
