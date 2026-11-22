import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installShortcuts } from "@desktop/main/shortcuts/install-shortcuts";
import { RECORDING_GUARD_MS } from "@desktop/main/shortcuts/shortcut-service";

type Listener = () => void;

function fakeWindow() {
  const windowListeners = new Map<string, Listener[]>();
  const contentsListeners = new Map<string, Listener[]>();
  const add = (map: Map<string, Listener[]>) => vi.fn((event: string, listener: Listener) => {
    map.set(event, [...(map.get(event) ?? []), listener]);
  });
  return {
    isDestroyed: vi.fn(() => false),
    on: add(windowListeners),
    webContents: {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      on: add(contentsListeners),
      setIgnoreMenuShortcuts: vi.fn(),
    },
    emit(event: string) { for (const listener of windowListeners.get(event) ?? []) listener(); },
    emitContents(event: string) { for (const listener of contentsListeners.get(event) ?? []) listener(); },
  };
}
type FakeWindow = ReturnType<typeof fakeWindow>;

function fakeApp() {
  let created: ((event: unknown, win: FakeWindow) => void) | null = null;
  return {
    on: vi.fn((_event: "browser-window-created", listener: (event: unknown, win: FakeWindow) => void) => { created = listener; }),
    removeListener: vi.fn(() => { created = null; }),
    create(win: FakeWindow) { created?.({}, win); },
  };
}

function fakeStore(initial: unknown = null) {
  return { get: vi.fn(async () => initial), set: vi.fn(async () => undefined) };
}

async function setup(options: { main?: FakeWindow | null; terminal?: FakeWindow | null; stored?: unknown } = {}) {
  const app = fakeApp();
  const store = fakeStore(options.stored ?? null);
  let main = options.main === undefined ? fakeWindow() : options.main;
  const terminal = options.terminal === undefined ? fakeWindow() : options.terminal;
  const installed = await installShortcuts({
    app: app as never,
    store: store as never,
    platform: "darwin",
    mainWindow: () => main as never,
    terminalWindow: () => terminal as never,
  });
  return { app, store, main, terminal, installed, setMain(win: FakeWindow | null) { main = win; } };
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
    main!.emitContents("did-start-navigation");
    expect(main!.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(main!.webContents.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(4);
  });

  it("leaves windows other than the main window alone", async () => {
    const { app, terminal } = await setup();
    app.create(terminal!);
    terminal!.emit("blur");
    terminal!.emitContents("did-start-navigation");
    expect(terminal!.webContents.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });

  it("stops watching new windows and clears the recording guard on dispose", async () => {
    vi.useFakeTimers();
    const { app, main, installed } = await setup();
    installed.service.setRecording(main!.webContents, true);
    installed.dispose();
    vi.advanceTimersByTime(RECORDING_GUARD_MS);
    expect(app.removeListener).toHaveBeenCalledWith("browser-window-created", expect.any(Function));
    expect(main!.webContents.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(1);
  });
});
