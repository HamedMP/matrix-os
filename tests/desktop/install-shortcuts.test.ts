import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installShortcuts } from "@desktop/main/shortcuts/install-shortcuts";
import { RECORDING_GUARD_MS } from "@desktop/main/shortcuts/shortcut-service";

type Listener = (...args: unknown[]) => void;

function emitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
    }),
    emit(event: string, ...args: unknown[]) { for (const listener of listeners.get(event) ?? []) listener(...args); },
    count(event: string) { return listeners.get(event)?.length ?? 0; },
  };
}

function fakeContents(type = "window") {
  const events = emitter();
  return {
    getType: vi.fn(() => type),
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    on: events.on,
    removeListener: events.removeListener,
    setIgnoreMenuShortcuts: vi.fn(),
    events,
  };
}
type FakeContents = ReturnType<typeof fakeContents>;

function fakeWindow() {
  const events = emitter();
  const webContents = fakeContents();
  return {
    isDestroyed: vi.fn(() => false),
    on: events.on,
    removeListener: events.removeListener,
    webContents,
    events,
    emit(event: string) { events.emit(event); },
    emitContents(event: string, ...args: unknown[]) { webContents.events.emit(event, ...args); },
  };
}
type FakeWindow = ReturnType<typeof fakeWindow>;

function fakeApp() {
  const events = emitter();
  return {
    on: events.on,
    removeListener: events.removeListener,
    events,
    create(win: FakeWindow) { events.emit("browser-window-created", {}, win); },
    createContents(contents: FakeContents) { events.emit("web-contents-created", {}, contents); },
  };
}

function fakeStore(initial: unknown = null) {
  return { get: vi.fn(async () => initial), set: vi.fn(async () => undefined) };
}

async function setup(options: {
  main?: FakeWindow | null; terminal?: FakeWindow | null; stored?: unknown; platform?: NodeJS.Platform;
} = {}) {
  const app = fakeApp();
  const store = fakeStore(options.stored ?? null);
  let main = options.main === undefined ? fakeWindow() : options.main;
  const terminal = options.terminal === undefined ? fakeWindow() : options.terminal;
  const run = vi.fn();
  const installed = await installShortcuts({
    app: app as never,
    store: store as never,
    platform: options.platform ?? "darwin",
    mainWindow: () => main as never,
    terminalWindow: () => terminal as never,
    run,
  });
  return { app, store, main, terminal, run, installed, setMain(win: FakeWindow | null) { main = win; } };
}

const MAIN_FRAME_NAVIGATION = { isMainFrame: true, isSameDocument: false };
const CTRL_TAB = {
  type: "keyDown", key: "Tab", code: "Tab", meta: false, control: true, alt: false, shift: false, isAutoRepeat: false,
};
const F6 = { ...CTRL_TAB, key: "F6", code: "F6", control: false };

function press(contents: FakeContents, input: typeof CTRL_TAB) {
  const event = { preventDefault: vi.fn() };
  contents.events.emit("before-input-event", event, input);
  return event.preventDefault;
}

const CHANGE = { version: 1 as const, overrides: { "app.close": ["F6"] } };

describe("installShortcuts", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads the stored overrides before returning", async () => {
    const { installed } = await setup({ stored: CHANGE });
    expect(installed.service.snapshot().effective["app.close"]).toEqual(["F6"]);
  });

  it("broadcasts changes to the main and Terminal windows", async () => {
    const { installed, main, terminal } = await setup();
    const snapshot = await installed.service.set(CHANGE);
    expect(main?.webContents.send).toHaveBeenCalledWith("shortcuts:changed", snapshot);
    expect(terminal?.webContents.send).toHaveBeenCalledWith("shortcuts:changed", snapshot);
  });

  it("skips absent and destroyed windows and isolates a failed send", async () => {
    const main = fakeWindow();
    main.isDestroyed.mockReturnValue(true);
    const { installed } = await setup({ main, terminal: null });
    await expect(installed.service.set(CHANGE)).resolves.toBeDefined();
    expect(main.webContents.send).not.toHaveBeenCalled();

    const failing = fakeWindow();
    failing.webContents.send.mockImplementation(() => { throw new Error("render frame disposed"); });
    const terminal = fakeWindow();
    const second = await setup({ main: failing, terminal });
    await expect(second.installed.service.set(CHANGE)).resolves.toBeDefined();
    expect(terminal.webContents.send).toHaveBeenCalledTimes(1);
  });

  it("stops recording when the main window blurs or navigates", async () => {
    const { app, main, installed } = await setup();
    app.create(main!);

    installed.service.setRecording(main!.webContents, true);
    main!.emit("blur");
    expect(main!.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);

    installed.service.setRecording(main!.webContents, true);
    main!.emitContents("did-start-navigation", MAIN_FRAME_NAVIGATION);
    expect(main!.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(main!.webContents.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(4);
  });

  it("keeps recording through subframe and same-document navigations", async () => {
    const { app, main, installed } = await setup();
    app.create(main!);
    installed.service.setRecording(main!.webContents, true);
    main!.emitContents("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    main!.emitContents("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(installed.service.isRecording()).toBe(true);
    expect(main!.webContents.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(1);
  });

  it("leaves windows other than the main window alone", async () => {
    const { app, terminal } = await setup();
    app.create(terminal!);
    terminal!.emit("blur");
    terminal!.emitContents("did-start-navigation", MAIN_FRAME_NAVIGATION);
    expect(terminal!.webContents.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });

  it("stops watching new windows and clears the recording guard on dispose", async () => {
    vi.useFakeTimers();
    const { app, main, installed } = await setup();
    installed.service.setRecording(main!.webContents, true);
    installed.dispose();
    vi.advanceTimersByTime(RECORDING_GUARD_MS);
    expect(app.events.count("browser-window-created")).toBe(0);
    expect(app.events.count("web-contents-created")).toBe(0);
    expect(main!.webContents.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(1);
  });

  it("detaches window listeners on dispose", async () => {
    const { app, main, installed } = await setup();
    app.create(main!);
    installed.dispose();
    expect(main!.events.count("blur")).toBe(0);
    expect(main!.events.count("closed")).toBe(0);
    expect(main!.webContents.events.count("did-start-navigation")).toBe(0);
  });

  it("does not touch a window after it closes, because Electron throws on a destroyed window", async () => {
    const { app, terminal, installed } = await setup();
    app.create(terminal!);
    // What Electron does once "closed" fires: every access throws.
    terminal!.isDestroyed.mockReturnValue(true);
    Object.defineProperty(terminal!, "webContents", {
      get() { throw new TypeError("Object has been destroyed"); },
    });
    terminal!.removeListener.mockImplementation(() => { throw new TypeError("Object has been destroyed"); });
    expect(() => terminal!.emit("closed")).not.toThrow();
    expect(() => installed.dispose()).not.toThrow();
  });

  it("runs a bound action from any web contents and stops the page from seeing the key", async () => {
    const { app, run } = await setup();
    const contents = fakeContents();
    app.createContents(contents);
    const preventDefault = press(contents, CTRL_TAB);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("app.next");
    expect(press(contents, F6)).not.toHaveBeenCalled();
  });

  // Spec 2706: Ctrl+Tab and Cmd+digits step through the Terminal window's own tabs and terminals there.
  it("leaves the Terminal window's own keys to that window", async () => {
    const { app, run, terminal } = await setup();
    app.createContents(terminal!.webContents);
    expect(press(terminal!.webContents, CTRL_TAB)).not.toHaveBeenCalled();
    expect(press(terminal!.webContents, { ...CTRL_TAB, key: "1", code: "Digit1", control: false, meta: true })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    const other = fakeContents();
    app.createContents(other);
    press(other, CTRL_TAB);
    expect(run).toHaveBeenCalledWith("app.next");
  });

  it("does not watch DevTools web contents", async () => {
    const { app, run } = await setup();
    const devtools = fakeContents("devtools");
    app.createContents(devtools);
    expect(devtools.events.count("before-input-event")).toBe(0);
    press(devtools, CTRL_TAB);
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves keys outside the Apps group to the page, so an app can claim Cmd+N", async () => {
    const { app, run } = await setup();
    const contents = fakeContents();
    app.createContents(contents);
    expect(press(contents, { ...CTRL_TAB, key: "n", code: "KeyN", meta: true, control: false })).not.toHaveBeenCalled();
    expect(press(contents, { ...CTRL_TAB, key: "T", code: "KeyT", meta: true, control: false, alt: true, shift: true }))
      .not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not take the Terminal window key on Windows", async () => {
    const { app, run } = await setup({ platform: "win32" });
    const contents = fakeContents();
    app.createContents(contents);
    expect(press(contents, { ...CTRL_TAB, key: "T", code: "KeyT", alt: true, shift: true })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("matches the bindings saved after install", async () => {
    const { app, run, installed } = await setup();
    const contents = fakeContents();
    app.createContents(contents);
    await installed.service.set(CHANGE);
    press(contents, F6);
    expect(run).toHaveBeenCalledWith("app.close");
  });

  it("lets keys through while a shortcut is being recorded", async () => {
    const { app, main, run, installed } = await setup();
    const contents = fakeContents();
    app.createContents(contents);
    installed.service.setRecording(main!.webContents, true);
    expect(press(contents, CTRL_TAB)).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  describe("keys a focused Terminal claims", () => {
    const TILE_LEFT = { ...CTRL_TAB, key: "ArrowLeft", code: "ArrowLeft", shift: true };

    async function claimed(window: "main" | "terminal") {
      const harness = await setup();
      const win = harness[window]!;
      harness.app.create(win);
      harness.app.createContents(win.webContents);
      harness.installed.service.setTerminalClaims(win.webContents, ["Ctrl+Shift+Left"]);
      return { ...harness, win };
    }

    it.each(["main", "terminal"] as const)("leaves a claimed key to the %s window's Terminal and runs nothing", async (window) => {
      const { win, run } = await claimed(window);
      expect(press(win.webContents, TILE_LEFT)).not.toHaveBeenCalled();
      // No action runs, so the Terminal window keeps focus: menu routing never sees the key.
      expect(run).not.toHaveBeenCalled();
      // An Apps key the window does not use still runs (Ctrl+Tab belongs to the Terminal window's own tabs).
      expect(press(win.webContents, { ...CTRL_TAB, key: "m", code: "KeyM", control: false, meta: true })).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith("app.minimize");
    });

    it("still arranges apps from other web contents while a Terminal claims the key", async () => {
      const { app, run } = await claimed("main");
      const view = fakeContents();
      app.createContents(view);
      expect(press(view, TILE_LEFT)).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith("app.tile-left");
    });

    it.each([
      ["the window blurs", (win: FakeWindow) => win.emit("blur")],
      ["the page navigates", (win: FakeWindow) => win.emitContents("did-start-navigation", MAIN_FRAME_NAVIGATION)],
      ["the window closes", (win: FakeWindow) => win.emit("closed")],
      ["the web contents is destroyed", (win: FakeWindow) => win.emitContents("destroyed")],
    ])("ends the claim when %s", async (_case, end) => {
      const { win, run, installed } = await claimed("terminal");
      end(win);
      expect(installed.service.isTerminalClaimed(win.webContents, "Ctrl+Shift+Left")).toBe(false);
      expect(press(win.webContents, TILE_LEFT)).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith("app.tile-left");
    });

    it("keeps the claim through subframe and same-document navigations", async () => {
      const { win, installed } = await claimed("main");
      win.emitContents("did-start-navigation", { isMainFrame: false, isSameDocument: false });
      win.emitContents("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      expect(installed.service.isTerminalClaimed(win.webContents, "Ctrl+Shift+Left")).toBe(true);
    });

    it("clears claims on a closed window without touching it", async () => {
      const { terminal, installed } = await claimed("terminal");
      const contents = terminal!.webContents;
      terminal!.isDestroyed.mockReturnValue(true);
      Object.defineProperty(terminal!, "webContents", {
        get() { throw new TypeError("Object has been destroyed"); },
      });
      expect(() => terminal!.emit("closed")).not.toThrow();
      expect(installed.service.isTerminalClaimed(contents, "Ctrl+Shift+Left")).toBe(false);
    });

    it("still stands down while a shortcut is being recorded", async () => {
      const { win, main, run, installed } = await claimed("main");
      installed.service.setTerminalClaims(win.webContents, []);
      installed.service.setRecording(main!.webContents, true);
      expect(press(win.webContents, TILE_LEFT)).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it("drops every claim on dispose", async () => {
      const { win, installed } = await claimed("main");
      installed.dispose();
      expect(installed.service.isTerminalClaimed(win.webContents, "Ctrl+Shift+Left")).toBe(false);
    });
  });

  it("detaches the key matcher on dispose and forgets destroyed web contents", async () => {
    const { app, run, installed } = await setup();
    const live = fakeContents();
    const destroyed = fakeContents();
    app.createContents(live);
    app.createContents(destroyed);
    destroyed.removeListener.mockImplementation(() => { throw new TypeError("Object has been destroyed"); });
    expect(() => destroyed.events.emit("destroyed")).not.toThrow();
    installed.dispose();
    expect(live.events.count("before-input-event")).toBe(0);
    expect(live.events.count("destroyed")).toBe(0);
    press(live, CTRL_TAB);
    expect(run).not.toHaveBeenCalled();
  });
});
