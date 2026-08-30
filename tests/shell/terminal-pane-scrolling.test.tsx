// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const createdTerminals = vi.hoisted(() => [] as Array<{
  options: Record<string, unknown>;
  element: HTMLElement | null;
  viewport: HTMLElement | null;
  cols: number;
  rows: number;
  logicalLines: string[];
  focus: ReturnType<typeof vi.fn>;
  flushWrites: () => void;
  emitData: (data: string) => void;
  resize: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  selection: string;
  customKeyEventHandler?: (event: KeyboardEvent) => boolean;
  clearSelection: ReturnType<typeof vi.fn>;
  selectAll: ReturnType<typeof vi.fn>;
  hasSelection: ReturnType<typeof vi.fn>;
}>);

const createdFitAddons = vi.hoisted(() => [] as Array<{
  fit: ReturnType<typeof vi.fn>;
  proposeDimensions: ReturnType<typeof vi.fn>;
}>);

const createdWebglAddons = vi.hoisted(() => [] as Array<{
  dispose: ReturnType<typeof vi.fn>;
  onContextLoss: ReturnType<typeof vi.fn>;
}>);

const stubWs = vi.hoisted(() => ({
  readyState: 1,
  send: vi.fn(),
  close: vi.fn(),
  onopen: null as (() => void) | null,
  onmessage: null as ((event: unknown) => void) | null,
  onclose: null as (() => void) | null,
  onerror: null as (() => void) | null,
}));

const buildAuthenticatedWebSocketUrl = vi.hoisted(() => vi.fn((
  path: string,
  query?: Record<string, string | undefined>,
) => {
  const url = new URL(`ws://localhost${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return Promise.resolve(url.toString());
}));

const restorePlan = vi.hoisted(() => ({
  current: {
    cached: null as null | {
      terminal: {
        element: HTMLElement | null;
        options: Record<string, unknown>;
        cols: number;
        rows: number;
        focus: ReturnType<typeof vi.fn>;
        loadAddon: ReturnType<typeof vi.fn>;
        refresh: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
        onData: ReturnType<typeof vi.fn>;
        onResize: ReturnType<typeof vi.fn>;
        attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
        clearSelection: ReturnType<typeof vi.fn>;
        getSelection: ReturnType<typeof vi.fn>;
        scrollToBottom: ReturnType<typeof vi.fn>;
      };
      fitAddon: {
        fit: ReturnType<typeof vi.fn>;
        proposeDimensions?: ReturnType<typeof vi.fn>;
      };
      webglAddon: null;
      searchAddon: null;
      ws: typeof stubWs;
      lastSeq: number;
      hasReplayCursor?: boolean;
      sessionId: string;
    },
    reuseTerminal: false,
    reuseSocket: false,
    sessionId: null as string | null,
    lastSeq: 0,
    hasReplayCursor: false,
  },
}));

const socketHealthConfigs = vi.hoisted(() => [] as Array<{ pingIntervalMs: number }>);

const useActualRestorePlan = vi.hoisted(() => ({ current: false }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    element: HTMLElement | null = null;
    viewport: HTMLElement | null = null;
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    parser = { registerOscHandler: vi.fn() };
    private writeCallbacks: Array<() => void> = [];
    private dataListener: ((data: string) => void) | null = null;
    private cursorColumn = 0;
    private readonly initialFontSize: number;
    logicalLines = [""];

    constructor(options: Record<string, unknown>) {
      this.initialFontSize = typeof options.fontSize === "number" ? options.fontSize : 13;
      this.options = new Proxy(options, {
        set: (target, property, value) => {
          target[property as string] = value;
          if (property === "fontSize") {
            this.updateScreenSize();
          }
          return true;
        },
      });
      createdTerminals.push(this);
    }

    private updateScreenSize(): void {
      const screen = this.element?.querySelector(".xterm-screen");
      if (!(screen instanceof HTMLElement)) {
        return;
      }
      const fontSize = typeof this.options.fontSize === "number"
        ? this.options.fontSize
        : this.initialFontSize;
      const fontScale = fontSize / this.initialFontSize;
      screen.style.width = `${this.cols * 10 * fontScale}px`;
      screen.style.height = `${this.rows * 20 * fontScale}px`;
    }

    loadAddon = vi.fn();
    focus = vi.fn();
    refresh = vi.fn();
    write = vi.fn((data: string, callback?: () => void) => {
      for (const char of data) {
        if (char === "\r") {
          this.cursorColumn = 0;
          continue;
        }
        if (char === "\n") {
          this.logicalLines.push("");
          this.cursorColumn = 0;
          continue;
        }
        if (this.cursorColumn >= this.cols) {
          this.logicalLines.push("");
          this.cursorColumn = 0;
        }
        this.logicalLines[this.logicalLines.length - 1] += char;
        this.cursorColumn += 1;
      }
      if (callback) {
        this.writeCallbacks.push(callback);
      }
    });
    flushWrites = () => {
      for (const callback of this.writeCallbacks.splice(0)) {
        callback();
      }
    };
    reset = vi.fn();
    selection = "";
    customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    dispose = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
      this.updateScreenSize();
    });
    onData = vi.fn((listener: (data: string) => void) => {
      this.dataListener = listener;
      return { dispose: vi.fn(() => { this.dataListener = null; }) };
    });
    emitData = (data: string) => this.dataListener?.(data);
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.customKeyEventHandler = handler;
    });
    clearSelection = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => this.selection.length > 0);
    getSelection = vi.fn(() => this.selection);
    scrollToBottom = vi.fn();
    registerLinkProvider = vi.fn();

    open(container: HTMLElement) {
      const root = document.createElement("div");
      root.className = "xterm";
      const viewport = document.createElement("div");
      viewport.className = "xterm-viewport";
      const scrollable = document.createElement("div");
      scrollable.className = "xterm-scrollable-element";
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      screen.style.width = `${this.cols * 10}px`;
      screen.style.height = `${this.rows * 20}px`;
      viewport.appendChild(screen);
      root.appendChild(scrollable);
      root.appendChild(viewport);
      container.appendChild(root);
      this.element = root;
      this.viewport = viewport;
      this.updateScreenSize();
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 120, rows: 42 }));

    constructor() {
      createdFitAddons.push(this);
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class MockWebglAddon {
    dispose = vi.fn();
    onContextLoss = vi.fn(() => ({ dispose: vi.fn() }));

    constructor() {
      createdWebglAddons.push(this);
    }
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class MockSearchAddon {},
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class MockSerializeAddon {},
}));

vi.mock("@xterm/addon-image", () => ({
  ImageAddon: class MockImageAddon {},
}));

vi.mock("../../shell/src/components/terminal/terminal-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shell/src/components/terminal/terminal-cache.js")>();
  return {
    ...actual,
    cacheTerminal: vi.fn(actual.cacheTerminal),
    takeCached: vi.fn(actual.takeCached),
    removeCached: vi.fn(actual.removeCached),
    hasCached: vi.fn(actual.hasCached),
  };
});

vi.mock("../../shell/src/components/terminal/terminal-restore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shell/src/components/terminal/terminal-restore.js")>();
  return {
    getCachedTerminalRestorePlan: vi.fn((cached) => (
      useActualRestorePlan.current ? actual.getCachedTerminalRestorePlan(cached) : restorePlan.current
    )),
    discardStaleCachedTerminal: vi.fn(actual.discardStaleCachedTerminal),
    closeStaleCachedSocket: vi.fn(actual.closeStaleCachedSocket),
  };
});

vi.mock("../../shell/src/components/terminal/terminal-appearance.js", () => ({
  applyTerminalAppearance: vi.fn(),
}));

vi.mock("@/lib/websocket-auth", () => ({
  buildAuthenticatedWebSocketUrl,
}));

vi.mock("@/lib/socket-health", () => ({
  createSocketHealth: vi.fn((config: { pingIntervalMs: number }) => {
    socketHealthConfigs.push(config);
    return {
    start: vi.fn(),
    stop: vi.fn(),
    pingNow: vi.fn(),
    receivedPong: vi.fn(),
    };
  }),
}));

vi.mock("@/lib/posthog-client", () => ({
  capturePostHogEvent: vi.fn(),
  capturePostHogLog: vi.fn(),
}));

vi.mock("@/stores/terminal-settings", () => {
  const state = {
    themeId: "system",
    fontSize: 13,
    fontFamily: "JetBrains Mono",
    ligatures: true,
    cursorStyle: "block",
    smoothScroll: true,
    cursorBlink: true,
  };
  return {
    useTerminalSettings: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

import { TerminalPane } from "../../shell/src/components/terminal/TerminalPane.js";
import { COLD_REPLAY_TIMEOUT_MS } from "../../shell/src/components/terminal/cold-replay-visibility.js";
import { cacheTerminal } from "../../shell/src/components/terminal/terminal-cache.js";
import { capturePostHogEvent } from "../../shell/src/lib/posthog-client.js";

const mockedCacheTerminal = vi.mocked(cacheTerminal);
const mockedCapturePostHogEvent = vi.mocked(capturePostHogEvent);

const theme = {
  mode: "dark",
  colors: { background: "#101820", foreground: "#f0efe7", primary: "#33aaff" },
  fonts: {},
} as unknown as Parameters<typeof TerminalPane>[0]["theme"];

const lightTheme = {
  mode: "light",
  colors: { background: "#FBF1C7", foreground: "#3C3836", primary: "#79740E" },
  fonts: {},
} as unknown as Parameters<typeof TerminalPane>[0]["theme"];

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

class WebSocketMock {
  static instances: WebSocketMock[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = WebSocketMock.OPEN;
  send = vi.fn((data: string) => {
    stubWs.send(data);
  });
  close = vi.fn(() => {
    this.readyState = WebSocketMock.CLOSED;
    stubWs.close();
  });
  onopen: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    WebSocketMock.instances.push(this);
  }
}

function installVisualViewportMock(input: { height: number; offsetTop: number }) {
  const listeners = new Map<string, Set<() => void>>();
  const viewport = {
    height: input.height,
    offsetTop: input.offsetTop,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}

function createCachedTerminal() {
  const element = document.createElement("div");
  element.className = "xterm";
  const viewport = document.createElement("div");
  viewport.className = "xterm-viewport";
  const scrollable = document.createElement("div");
  scrollable.className = "xterm-scrollable-element";
  element.appendChild(scrollable);
  element.appendChild(viewport);

  return {
    terminal: {
      element,
      options: {},
      cols: 80,
      rows: 24,
      focus: vi.fn(),
      loadAddon: vi.fn(),
      refresh: vi.fn(),
      write: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn(),
      clearSelection: vi.fn(),
      hasSelection: vi.fn(() => false),
      selectAll: vi.fn(),
      getSelection: vi.fn(() => ""),
      scrollToBottom: vi.fn(),
    },
    viewport,
  };
}

describe("TerminalPane scrolling", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    createdTerminals.length = 0;
    createdFitAddons.length = 0;
    createdWebglAddons.length = 0;
    restorePlan.current = {
      cached: null,
      reuseTerminal: false,
      reuseSocket: false,
      sessionId: null,
      lastSeq: 0,
      hasReplayCursor: false,
    };
    useActualRestorePlan.current = false;
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    globalThis.WebSocket = WebSocketMock as unknown as typeof WebSocket;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1_200,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 840,
    });
    stubWs.send.mockReset();
    stubWs.close.mockReset();
    stubWs.readyState = WebSocketMock.OPEN;
    mockedCacheTerminal.mockClear();
    mockedCapturePostHogEvent.mockClear();
    WebSocketMock.instances.length = 0;
    ResizeObserverMock.instances.length = 0;
    buildAuthenticatedWebSocketUrl.mockReset();
    buildAuthenticatedWebSocketUrl.mockImplementation((path, query) => {
      const url = new URL(`ws://localhost${path}`);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value) {
          url.searchParams.set(key, value);
        }
      }
      return Promise.resolve(url.toString());
    });
    socketHealthConfigs.length = 0;
    Reflect.deleteProperty(window, "visualViewport");
  });

  afterEach(() => {
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(navigator, "platform", originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "platform");
    }
  });

  it.each([
    { label: "Command+C", metaKey: true, ctrlKey: false, shiftKey: false },
    { label: "Command+Shift+C", metaKey: true, ctrlKey: false, shiftKey: true },
    { label: "Ctrl+Shift+C", metaKey: false, ctrlKey: true, shiftKey: true },
  ])("copies the focused pane selection once with $label and keeps it selected", async ({ metaKey, ctrlKey, shiftKey }) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <TerminalPane
        paneId="pane-clipboard-copy"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(createdTerminals[0]?.customKeyEventHandler).toBeTypeOf("function"));
    const terminal = createdTerminals[0]!;
    terminal.selection = "first row\nλ second row 👩🏽‍💻";
    const preventDefault = vi.fn();

    const handled = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "c",
      metaKey,
      ctrlKey,
      shiftKey,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("first row\nλ second row 👩🏽‍💻");
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(terminal.selection).toBe("first row\nλ second row 👩🏽‍💻");
  });

  it.each([
    { label: "Command+V", metaKey: true, ctrlKey: false, shiftKey: false },
    { label: "Ctrl+Shift+V", metaKey: false, ctrlKey: true, shiftKey: true },
  ])("pastes into the initiating pane exactly once without Enter with $label", async ({ metaKey, ctrlKey, shiftKey }) => {
    const readText = vi.fn().mockResolvedValue("printf 'λ 👩🏽‍💻'");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    render(
      <TerminalPane
        paneId="pane-clipboard-paste"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const terminal = createdTerminals[0]!;
    const socket = WebSocketMock.instances[0]!;
    socket.send.mockClear();
    const preventDefault = vi.fn();

    const handled = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "v",
      metaKey,
      ctrlKey,
      shiftKey,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    expect(readText).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({
      type: "input",
      data: "\x1b[200~printf 'λ 👩🏽‍💻'\x1b[201~",
    });
  });

  it("leaves clipboard shortcuts to the shell when no terminal action can run", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn() },
    });
    render(
      <TerminalPane
        paneId="pane-clipboard-precedence"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(createdTerminals[0]?.customKeyEventHandler).toBeTypeOf("function"));
    const terminal = createdTerminals[0]!;
    const preventDefault = vi.fn();

    const withoutSelection = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "c",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);
    const repeatedPaste = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "v",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: true,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(withoutSelection).toBe(true);
    expect(repeatedPaste).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("selects all terminal scrollback with Command+A", async () => {
    render(
      <TerminalPane
        paneId="pane-select-all"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(createdTerminals[0]?.customKeyEventHandler).toBeTypeOf("function"));
    const terminal = createdTerminals[0]!;
    const preventDefault = vi.fn();

    const handled = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "a",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(terminal.selectAll).toHaveBeenCalledOnce();
  });

  it("does not treat Meta+C as a macOS shortcut on non-Mac platforms", async () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "Linux x86_64",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <TerminalPane
        paneId="pane-non-mac-meta"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(createdTerminals[0]?.customKeyEventHandler).toBeTypeOf("function"));
    const terminal = createdTerminals[0]!;
    terminal.selection = "leave this selection alone";
    const preventDefault = vi.fn();

    const handled = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "c",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("cancels delayed clipboard paste after pane session replacement or unmount", async () => {
    const replacementRead = deferred<string>();
    const unmountRead = deferred<string>();
    const readText = vi.fn()
      .mockImplementationOnce(() => replacementRead.promise)
      .mockImplementationOnce(() => unmountRead.promise);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const view = render(
      <TerminalPane
        paneId="pane-stale-paste"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(createdTerminals[0]?.customKeyEventHandler).toBeTypeOf("function"));
    const paste = () => createdTerminals[0]!.customKeyEventHandler?.({
      type: "keydown",
      key: "v",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    paste();
    view.rerender(
      <TerminalPane
        paneId="pane-stale-paste"
        cwd=""
        theme={theme}
        isFocused
        sessionId="replacement"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    replacementRead.resolve("must not reach replacement");
    await act(async () => replacementRead.promise);
    expect(stubWs.send).not.toHaveBeenCalledWith(expect.stringContaining("must not reach replacement"));

    paste();
    view.unmount();
    unmountRead.resolve("must not write after unmount");
    await act(async () => unmountRead.promise);
    expect(stubWs.send).not.toHaveBeenCalledWith(expect.stringContaining("must not write after unmount"));
  });

  it("shows generic paste feedback and retries exactly once after recovery", async () => {
    const readText = vi.fn()
      .mockRejectedValueOnce(new Error("OpenAI /Users/operator/private.txt session-main"))
      .mockResolvedValueOnce("retry payload");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    render(
      <TerminalPane
        paneId="pane-paste-retry"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(createdTerminals[0]?.customKeyEventHandler).toBeTypeOf("function"));
    const paste = () => createdTerminals[0]!.customKeyEventHandler?.({
      type: "keydown",
      key: "v",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    paste();
    expect(await screen.findByText(/Clipboard paste failed\. Try again/)).toBeTruthy();
    stubWs.send.mockClear();
    paste();
    await waitFor(() => expect(stubWs.send).toHaveBeenCalledOnce());
    expect(JSON.parse(stubWs.send.mock.calls[0]![0])).toEqual({
      type: "input",
      data: "\x1b[200~retry payload\x1b[201~",
    });
  });

  it("captures right-click before inner xterm can replace the multiline selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <TerminalPane
        paneId="pane-context-copy"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(createdTerminals[0]?.customKeyEventHandler).toBeTypeOf("function"));
    const terminal = createdTerminals[0]!;
    const root = terminal.element!;
    terminal.selection = "first row\nλ second row 👩🏽‍💻";
    terminal.focus.mockClear();
    root.addEventListener("contextmenu", () => {
      terminal.selection = "hovered";
    });

    expect(terminal.options.rightClickSelectsWord).toBe(false);
    expect(fireEvent.contextMenu(root, { clientX: 120, clientY: 80 })).toBe(false);
    const copy = screen.getByRole("menuitem", { name: "Copy" }) as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    terminal.focus.mockClear();
    fireEvent.click(copy);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("first row\nλ second row 👩🏽‍💻");
    expect(terminal.selection).toBe("first row\nλ second row 👩🏽‍💻");
    expect(terminal.focus).toHaveBeenCalled();
  });

  it("shields a completed selection before Canvas correction and resumes TUI mouse reports after clear", async () => {
    const view = render(
      <TerminalPane
        paneId="pane-selection-shield"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        canvasZoom={0.5}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(createdTerminals[0]?.customKeyEventHandler).toBeTypeOf("function"));
    const terminal = createdTerminals[0]!;
    const root = terminal.element!;
    const reports: string[] = [];
    for (const type of ["mousemove", "mousedown", "mouseup"] as const) {
      root.addEventListener(type, () => {
        reports.push(type);
        terminal.selection = "";
      });
    }
    terminal.selection = "first row\nλ second row 👩🏽‍💻";

    for (let index = 0; index < 20; index += 1) {
      fireEvent.mouseMove(root, { button: 0, buttons: 0 });
    }
    fireEvent.mouseDown(root, { button: 2, buttons: 2 });
    fireEvent.mouseUp(root, { button: 2, buttons: 0 });

    expect(reports).toEqual([]);
    expect(terminal.selection).toBe("first row\nλ second row 👩🏽‍💻");

    view.rerender(
      <TerminalPane
        paneId="pane-selection-shield"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        canvasZoom={1}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    fireEvent.mouseDown(root, { button: 0, buttons: 1 });
    expect(reports).toEqual(["mousedown"]);
    expect(terminal.selection).toBe("");

    fireEvent.mouseMove(root, { button: 0, buttons: 0 });
    expect(reports).toEqual(["mousedown", "mousemove"]);
  });

  it("selects xterm scrollback with Command+A and preserves keyboard/menu Copy parity", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <TerminalPane
        paneId="pane-select-all"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(createdTerminals[0]?.customKeyEventHandler).toBeTypeOf("function"));
    const terminal = createdTerminals[0]!;
    const selectedScrollback = "old scrollback row\nvisible λ row 👩🏽‍💻";
    terminal.selectAll.mockImplementation(() => {
      terminal.selection = selectedScrollback;
    });
    const preventDefault = vi.fn();

    const handled = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "a",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(terminal.selectAll).toHaveBeenCalledOnce();
    fireEvent.mouseMove(terminal.element!, { button: 0, buttons: 0 });
    expect(terminal.selection).toBe(selectedScrollback);

    terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "c",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    fireEvent.contextMenu(terminal.element!, { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls).toEqual([[selectedScrollback], [selectedScrollback]]);
  });

  it("attaches desktop canonical sessions as hard clients with proposed dimensions", async () => {
    render(
      <TerminalPane
        paneId="pane-hard-attach"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    expect(buildAuthenticatedWebSocketUrl).toHaveBeenCalledWith(
      "/ws/terminal/session",
      expect.objectContaining({
        session: "main",
        client: "hard",
        lease: "exclusive",
        cols: "120",
        rows: "42",
      }),
    );
    expect(createdFitAddons[0].proposeDimensions).toHaveBeenCalled();
    expect(createdFitAddons[0].fit).not.toHaveBeenCalled();
    expect(createdTerminals[0].resize).not.toHaveBeenCalled();
  });

  it("restarts a pending observer connection with an exclusive lease when the pane becomes focused", async () => {
    let resolveObserverUrl: (() => void) | null = null;
    buildAuthenticatedWebSocketUrl
      .mockImplementationOnce((path, query) => new Promise<string>((resolve) => {
        const url = new URL(`ws://localhost${path}`);
        for (const [key, value] of Object.entries(query ?? {})) {
          if (value) url.searchParams.set(key, value);
        }
        resolveObserverUrl = () => resolve(url.toString());
      }));

    const props = {
      paneId: "pane-pending-focus-takeover",
      cwd: "",
      theme,
      sessionId: "main",
      isClosing: false,
      shouldCacheOnUnmount: () => false,
      shouldDestroyOnUnmount: () => false,
      onFocus: () => {},
    } satisfies Omit<Parameters<typeof TerminalPane>[0], "isFocused">;
    const view = render(<TerminalPane {...props} isFocused={false} />);

    await waitFor(() => expect(buildAuthenticatedWebSocketUrl).toHaveBeenCalledTimes(1));
    expect(buildAuthenticatedWebSocketUrl.mock.calls[0]?.[1]).not.toHaveProperty("lease");

    view.rerender(<TerminalPane {...props} isFocused />);

    await waitFor(() => expect(buildAuthenticatedWebSocketUrl).toHaveBeenCalledTimes(2));
    expect(buildAuthenticatedWebSocketUrl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      session: "main",
      client: "hard",
      lease: "exclusive",
      cols: "120",
      rows: "42",
    }));

    await act(async () => {
      resolveObserverUrl?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    expect(new URL(WebSocketMock.instances[0]!.url).searchParams.get("lease")).toBe("exclusive");
  });

  it("renews the focused web terminal lease well before gateway expiry", async () => {
    render(
      <TerminalPane
        paneId="pane-heartbeat"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    WebSocketMock.instances[0]!.onopen?.();

    expect(socketHealthConfigs.at(-1)?.pingIntervalMs).toBe(10_000);
  });

  it("resets the web xterm before a replacement Zellij presentation", async () => {
    render(
      <TerminalPane
        paneId="pane-presentation-reset"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const socket = WebSocketMock.instances[0]!;
    const terminal = createdTerminals[0]!;
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 0 }),
      });
      socket.onmessage?.({ data: JSON.stringify({ type: "presentation-reset" }) });
    });

    expect(terminal.reset).toHaveBeenCalledOnce();
  });

  it("waits for a measurable hard pane instead of attaching with a destructive fallback", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 0,
    });

    const { container } = render(
      <TerminalPane
        paneId="pane-hidden-hard-attach"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdFitAddons).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(WebSocketMock.instances).toHaveLength(0);

    const pane = container.firstElementChild as HTMLElement;
    Object.defineProperty(pane, "clientWidth", { configurable: true, value: 1_010 });
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 660 });
    createdFitAddons[0].proposeDimensions.mockReturnValue({ cols: 999, rows: 999 });
    await waitFor(() => expect(ResizeObserverMock.instances).not.toHaveLength(0));
    await act(async () => {
      ResizeObserverMock.instances.at(-1)!.trigger();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    expect(buildAuthenticatedWebSocketUrl).toHaveBeenLastCalledWith(
      "/ws/terminal/session",
      expect.objectContaining({ client: "hard", cols: "500", rows: "200" }),
    );
  });

  it("keeps mobile canonical sessions soft", async () => {
    render(
      <TerminalPane
        paneId="pane-soft-attach"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        suppressNativeKeyboard
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    expect(buildAuthenticatedWebSocketUrl).toHaveBeenCalledWith(
      "/ws/terminal/session",
      expect.objectContaining({ session: "main", client: "soft" }),
    );
    const query = buildAuthenticatedWebSocketUrl.mock.calls.at(-1)?.[1];
    expect(query).not.toHaveProperty("cols");
    expect(query).not.toHaveProperty("rows");
  });

  it("declares deduplicated hard-client proposals without locally resizing xterm", async () => {
    const { container } = render(
      <TerminalPane
        paneId="pane-hard-resize"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const terminal = createdTerminals[0];
    const fitAddon = createdFitAddons[0];
    const pane = container.firstElementChild as HTMLElement;
    fitAddon.proposeDimensions.mockReturnValue({ cols: 154, rows: 51 });

    await act(async () => {
      ResizeObserverMock.instances.at(-1)!.trigger();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(stubWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "resize", cols: 154, rows: 51 }));
    expect(terminal.resize).not.toHaveBeenCalled();
    expect(fitAddon.fit).not.toHaveBeenCalled();

    const resizeCount = stubWs.send.mock.calls.filter(([frame]) => (
      JSON.parse(frame as string) as { type: string }
    ).type === "resize").length;
    await act(async () => {
      ResizeObserverMock.instances.at(-1)!.trigger();
      ResizeObserverMock.instances.at(-1)!.trigger();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(stubWs.send.mock.calls.filter(([frame]) => (
      JSON.parse(frame as string) as { type: string }
    ).type === "resize")).toHaveLength(resizeCount);

    Object.defineProperty(pane, "clientWidth", { configurable: true, value: 0 });
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 0 });
    fitAddon.proposeDimensions.mockReturnValue({ cols: 1, rows: 1 });
    await act(async () => {
      ResizeObserverMock.instances.at(-1)!.trigger();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(stubWs.send.mock.calls.filter(([frame]) => (
      JSON.parse(frame as string) as { type: string }
    ).type === "resize")).toHaveLength(resizeCount);
  });

  it("resizes hard-client xterm only after gateway canonical confirmation", async () => {
    render(
      <TerminalPane
        paneId="pane-hard-confirmation"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const terminal = createdTerminals[0];
    const socket = WebSocketMock.instances[0];
    expect(terminal.resize).not.toHaveBeenCalled();

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: "canonical-size", cols: 146, rows: 47 }),
      });
    });
    expect(terminal.resize).toHaveBeenLastCalledWith(146, 47);
    expect(createdFitAddons[0].fit).not.toHaveBeenCalled();
  });

  it("renders a soft mobile browser on the authoritative 140x40 grid across repeated local resizes", async () => {
    const { container } = render(
      <TerminalPane
        paneId="pane-soft-grid"
        cwd=""
        theme={theme}
        isFocused
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        suppressNativeKeyboard
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdTerminals).toHaveLength(1));
    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const terminal = createdTerminals[0];
    const fitAddon = createdFitAddons[0];
    const socket = WebSocketMock.instances[0];
    const pane = container.firstElementChild as HTMLElement;
    Object.defineProperty(pane, "clientWidth", { configurable: true, value: 700 });
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 800 });

    expect(buildAuthenticatedWebSocketUrl).toHaveBeenCalledWith(
      "/ws/terminal/session",
      expect.objectContaining({ session: "main", client: "soft" }),
    );

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "attached",
          session: "main",
          state: "running",
          fromSeq: 0,
          canonicalSize: { cols: 140, rows: 40 },
        }),
      });
    });

    await waitFor(() => expect(terminal.resize).toHaveBeenLastCalledWith(140, 40));
    await waitFor(() => expect(terminal.options.fontSize).toBe(10));
    await waitFor(() => expect(terminal.element?.style.transform).toBe("scale(1)"));
    expect(terminal.cols).toBe(140);
    expect(terminal.rows).toBe(40);
    expect(fitAddon.fit).not.toHaveBeenCalled();

    const longLsRow = [
      "-rw-r--r-- 1 matrix matrix 4096 Jul 31 20:00",
      "a-very-long-ls-style-filename-that-crosses-the-seventy-column-browser-width.txt",
    ].join(" ");
    expect(longLsRow.length).toBeGreaterThan(70);
    expect(longLsRow.length).toBeLessThan(140);

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: "output", seq: 1, data: `${longLsRow}\r\n$ ` }),
      });
    });
    expect(terminal.logicalLines[0]).toBe(longLsRow);
    expect(terminal.logicalLines[1]).toBe("$ ");
    expect(terminal.logicalLines.filter((line) => line === "$ ")).toHaveLength(1);

    const canonicalResizeCount = terminal.resize.mock.calls.length;
    await act(async () => {
      const observer = ResizeObserverMock.instances.at(-1)!;
      observer.trigger();
      observer.trigger();
      observer.trigger();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(terminal.resize).toHaveBeenCalledTimes(canonicalResizeCount);
    expect(stubWs.send.mock.calls
      .map(([frame]) => JSON.parse(frame as string) as { type: string })
      .filter((frame) => frame.type === "resize")).toHaveLength(0);

    terminal.emitData("x");
    expect(stubWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "input", data: "x" }));

    Object.defineProperty(pane, "clientWidth", { configurable: true, value: 1_600 });
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 900 });
    await act(async () => {
      ResizeObserverMock.instances.at(-1)!.trigger();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(terminal.element?.style.transform).toBe("scale(1)");
    expect(terminal.options.fontSize).toBe(13);
    expect(terminal.cols).toBe(140);
    expect(terminal.rows).toBe(40);

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: "canonical-size", cols: 132, rows: 36 }),
      });
    });
    await waitFor(() => expect(terminal.resize).toHaveBeenLastCalledWith(132, 36));
  });

  it("configures xterm scrollback and native viewport scrolling after mount", async () => {
    render(
      <TerminalPane
        paneId="pane-scrolling-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdTerminals).toHaveLength(1));

    const terminal = createdTerminals[0];
    expect(terminal.options).toEqual(expect.objectContaining({
      scrollback: 10_000,
      scrollSensitivity: 1,
      fastScrollSensitivity: 5,
      scrollOnUserInput: true,
      smoothScrollDuration: 125,
    }));

    await waitFor(() => expect(terminal.viewport).not.toBeNull());

    expect(terminal.element?.style.height).toBe("100%");
    expect(terminal.element?.style.overscrollBehavior).toBe("contain");
    expect(terminal.element?.style.touchAction).toBe("pan-y");
    expect(terminal.viewport?.style.height).toBe("100%");
    expect(terminal.viewport?.style.overflowY).toBe("scroll");
    expect(terminal.viewport?.style.getPropertyValue("scrollbar-gutter")).toBe("stable");
    expect(terminal.viewport?.style.overscrollBehavior).toBe("contain");
    expect(terminal.viewport?.style.touchAction).toBe("pan-y");
  });

  it("applies scroll surface and options to cached xterm instances on restore", async () => {
    const cached = createCachedTerminal();
    const fitAddon = { fit: vi.fn() };
    restorePlan.current = {
      cached: {
        terminal: cached.terminal,
        fitAddon,
        webglAddon: null,
        searchAddon: null,
        ws: stubWs,
        lastSeq: 0,
        hasReplayCursor: false,
        sessionId: "cached-terminal",
      },
      reuseTerminal: true,
      reuseSocket: true,
      sessionId: "cached-terminal",
      lastSeq: 0,
      hasReplayCursor: false,
    };

    const { container } = render(
      <TerminalPane
        paneId="pane-cached-scrolling-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(container.querySelector(".xterm")).toBe(cached.terminal.element));

    expect(createdTerminals).toHaveLength(0);
    expect(cached.terminal.options).toEqual(expect.objectContaining({
      scrollback: 10_000,
      scrollSensitivity: 1,
      fastScrollSensitivity: 5,
      scrollOnUserInput: true,
    }));
    expect(cached.terminal.element?.style.height).toBe("100%");
    expect(cached.terminal.element?.style.overscrollBehavior).toBe("contain");
    expect(cached.terminal.element?.style.touchAction).toBe("pan-y");
    expect(cached.viewport.style.height).toBe("100%");
    expect(cached.viewport.style.overflowY).toBe("scroll");
    expect(cached.viewport.style.getPropertyValue("scrollbar-gutter")).toBe("stable");
    expect(cached.viewport.style.overscrollBehavior).toBe("contain");
    expect(cached.viewport.style.touchAction).toBe("pan-y");
  });

  it("disposes WebGL before caching an unmounted desktop pane", async () => {
    const { unmount } = render(
      <TerminalPane
        paneId="pane-cache-webgl-dispose-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => true}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdWebglAddons).toHaveLength(1));
    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));

    await act(async () => {
      unmount();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockedCacheTerminal).toHaveBeenCalledOnce());

    const webglAddon = createdWebglAddons[0];
    expect(webglAddon.dispose).toHaveBeenCalledOnce();
    expect(webglAddon.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      mockedCacheTerminal.mock.invocationCallOrder[0],
    );
    expect(mockedCacheTerminal.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      terminal: createdTerminals[0],
      fitAddon: createdFitAddons[0],
      webglAddon: null,
      ws: WebSocketMock.instances[0],
    }));
  });

  it("reattaches and refreshes a DOM cached terminal before re-enabling WebGL", async () => {
    const cached = createCachedTerminal();
    const fitAddon = { fit: vi.fn() };
    restorePlan.current = {
      cached: {
        terminal: cached.terminal,
        fitAddon,
        webglAddon: null,
        searchAddon: null,
        ws: stubWs,
        lastSeq: 14,
        hasReplayCursor: true,
        sessionId: "cached-terminal-with-dom-renderer",
      },
      reuseTerminal: true,
      reuseSocket: true,
      sessionId: "cached-terminal-with-dom-renderer",
      lastSeq: 14,
      hasReplayCursor: true,
    };

    const { container } = render(
      <TerminalPane
        paneId="pane-cached-webgl-restore-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(container.querySelector(".xterm")).toBe(cached.terminal.element));
    await waitFor(() => expect(cached.terminal.refresh).toHaveBeenCalledWith(0, 23));
    await waitFor(() => expect(createdWebglAddons).toHaveLength(1));

    expect(createdTerminals).toHaveLength(0);
    expect(fitAddon.fit).toHaveBeenCalled();
    expect(cached.terminal.loadAddon).toHaveBeenCalledWith(createdWebglAddons[0]);
    expect(fitAddon.fit.mock.invocationCallOrder[0]).toBeLessThan(
      cached.terminal.loadAddon.mock.invocationCallOrder[0],
    );
    expect(cached.terminal.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      cached.terminal.loadAddon.mock.invocationCallOrder[0],
    );
  });

  it("does not refocus xterm on mobile visual viewport resize when native keyboard is suppressed", async () => {
    const viewport = installVisualViewportMock({ height: 800, offsetTop: 0 });

    render(
      <TerminalPane
        paneId="pane-mobile-keyboard-test"
        cwd=""
        theme={theme}
        isFocused
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        suppressNativeKeyboard
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdTerminals).toHaveLength(1));
    await waitFor(() => expect(createdFitAddons).toHaveLength(1));

    const terminal = createdTerminals[0];
    const fitAddon = createdFitAddons[0];
    terminal.focus.mockClear();
    fitAddon.fit.mockClear();

    await act(async () => {
      viewport.height = 560;
      viewport.dispatch("resize");
    });

    await waitFor(() => expect(fitAddon.fit).toHaveBeenCalled());
    expect(terminal.focus).not.toHaveBeenCalled();
    expect(terminal.scrollToBottom).toHaveBeenCalled();
  });

  it("does not programmatically focus xterm on mount when native keyboard is suppressed", async () => {
    render(
      <TerminalPane
        paneId="pane-mobile-initial-focus-test"
        cwd=""
        theme={theme}
        isFocused
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        suppressNativeKeyboard
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdTerminals).toHaveLength(1));
    await waitFor(() => expect(createdFitAddons).toHaveLength(1));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(createdFitAddons[0].fit).toHaveBeenCalled();
    expect(createdTerminals[0].focus).not.toHaveBeenCalled();
  });

  it("does not shrink the terminal host by the mobile keyboard height variable", async () => {
    render(
      <TerminalPane
        paneId="pane-mobile-height-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        suppressNativeKeyboard
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdTerminals).toHaveLength(1));

    const host = document.querySelector(".ph-no-capture") as HTMLElement;
    expect(host.style.height).toBe("");
  });

  it("uses the DOM renderer instead of WebGL when native keyboard input is suppressed", async () => {
    render(
      <TerminalPane
        paneId="pane-mobile-dom-renderer-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        suppressNativeKeyboard
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdTerminals).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createdWebglAddons).toHaveLength(0);
    expect(createdTerminals[0].loadAddon).not.toHaveBeenCalledWith(expect.objectContaining({
      onContextLoss: expect.any(Function),
    }));
  });

  it("loads WebGL on fresh desktop panes", async () => {
    render(
      <TerminalPane
        paneId="pane-desktop-webgl-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdWebglAddons).toHaveLength(1));
    expect(createdTerminals[0].loadAddon).toHaveBeenCalledWith(createdWebglAddons[0]);
  });

  it("themes fresh, cached, and live xterm background surfaces", async () => {
    const fresh = render(
      <TerminalPane
        paneId="pane-light-background"
        cwd=""
        theme={lightTheme}
        isFocused={false}
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdTerminals).toHaveLength(1));
    const root = createdTerminals[0].element!;
    expect((fresh.container.firstElementChild as HTMLElement).style.backgroundColor).toBe("rgb(251, 241, 199)");
    expect(root.style.backgroundColor).toBe("rgb(251, 241, 199)");
    expect((root.querySelector(".xterm-viewport") as HTMLElement).style.backgroundColor).toBe("rgb(251, 241, 199)");
    expect((root.querySelector(".xterm-scrollable-element") as HTMLElement).style.backgroundColor).toBe("rgb(251, 241, 199)");

    fresh.rerender(
      <TerminalPane
        paneId="pane-light-background"
        cwd=""
        theme={theme}
        isFocused={false}
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(root.style.backgroundColor).toBe("rgb(16, 24, 32)"));
    expect((root.querySelector(".xterm-viewport") as HTMLElement).style.backgroundColor).toBe("rgb(16, 24, 32)");
    expect((root.querySelector(".xterm-scrollable-element") as HTMLElement).style.backgroundColor).toBe("rgb(16, 24, 32)");
    fresh.unmount();

    const cached = createCachedTerminal();
    restorePlan.current = {
      cached: {
        terminal: cached.terminal,
        fitAddon: { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 120, rows: 42 })) },
        webglAddon: null,
        searchAddon: null,
        ws: stubWs,
        lastSeq: 0,
        sessionId: "main",
      },
      reuseTerminal: true,
      reuseSocket: true,
      sessionId: "main",
      lastSeq: 0,
      hasReplayCursor: false,
    };
    render(
      <TerminalPane
        paneId="pane-cached-light-background"
        cwd=""
        theme={lightTheme}
        isFocused={false}
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => expect(cached.terminal.element.parentElement).not.toBeNull());
    expect(cached.terminal.element.style.backgroundColor).toBe("rgb(251, 241, 199)");
    expect(cached.viewport.style.backgroundColor).toBe("rgb(251, 241, 199)");
    expect((cached.terminal.element.querySelector(".xterm-scrollable-element") as HTMLElement).style.backgroundColor).toBe("rgb(251, 241, 199)");
  });

  it("enforces light-theme contrast in both the default and WebGL renderers", async () => {
    const { unmount } = render(
      <TerminalPane
        paneId="pane-light-webgl-contrast-test"
        cwd=""
        theme={lightTheme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdTerminals).toHaveLength(1));
    await waitFor(() => expect(createdWebglAddons).toHaveLength(1));
    expect(createdTerminals[0].options.minimumContrastRatio).toBe(4.5);
    expect(createdTerminals[0].loadAddon).toHaveBeenCalledWith(createdWebglAddons[0]);
    unmount();

    createdTerminals.length = 0;
    createdWebglAddons.length = 0;
    render(
      <TerminalPane
        paneId="pane-light-dom-contrast-test"
        cwd=""
        theme={lightTheme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        suppressNativeKeyboard
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(createdTerminals).toHaveLength(1));
    expect(createdTerminals[0].options.minimumContrastRatio).toBe(4.5);
    expect(createdWebglAddons).toHaveLength(0);
  });

  it("requests retained scrollback from zero for a fresh canonical browser session", async () => {
    render(
      <TerminalPane
        paneId="pane-cold-replay-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        sessionId="main"
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const url = new URL(WebSocketMock.instances[0]!.url);

    expect(url.pathname).toBe("/ws/terminal/session");
    expect(url.searchParams.get("session")).toBe("main");
    expect(url.searchParams.get("fromSeq")).toBe("0");
    expect(url.searchParams.get("fromSeq")).not.toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it("renders retained output into a new xterm after a full canonical-session remount", async () => {
    const props = {
      paneId: "pane-full-remount-test",
      cwd: "",
      theme,
      isFocused: false,
      isClosing: false,
      sessionId: "main",
      shouldCacheOnUnmount: () => false,
      shouldDestroyOnUnmount: () => false,
      onFocus: () => {},
    } satisfies Parameters<typeof TerminalPane>[0];
    const firstMount = render(<TerminalPane {...props} />);

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    firstMount.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    render(<TerminalPane {...props} />);
    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(2));
    expect(createdTerminals).toHaveLength(2);
    const restoredSocket = WebSocketMock.instances[1]!;
    const restoredTerminal = createdTerminals[1]!;
    expect(new URL(restoredSocket.url).searchParams.get("fromSeq")).toBe("0");

    await act(async () => {
      restoredSocket.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 0 }),
      });
      restoredSocket.onmessage?.({ data: JSON.stringify({ type: "replay-start", fromSeq: 0 }) });
      restoredSocket.onmessage?.({
        data: JSON.stringify({ type: "output", seq: 0, data: "retained-before-refresh\r\n" }),
      });
      restoredSocket.onmessage?.({ data: JSON.stringify({ type: "replay-end" }) });
    });

    expect(restoredTerminal.write).toHaveBeenCalledWith("retained-before-refresh\r\n");
  });

  it("keeps a fresh canonical xterm hidden while old alternate-screen frames rebuild the current viewport", async () => {
    render(
      <TerminalPane
        paneId="pane-private-cold-replay-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        sessionId="main"
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const socket = WebSocketMock.instances[0]!;
    const terminal = createdTerminals[0]!;
    await waitFor(() => expect(terminal.element).not.toBeNull());

    expect(terminal.element?.style.visibility).toBe("hidden");

    const replayFrames = [
      "\x1b[?10",
      "49h\x1b[32mOLD_CMATRIX_FRAME_A\r\n",
      "OLD_CMATRIX_FRAME_B\x1b[0m\x1b[?104",
      "9l\x1b[2J\x1b[H",
      "CURRENT_ECHO_OUTPUT\r\n",
    ];
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 0 }),
      });
      socket.onmessage?.({ data: JSON.stringify({ type: "replay-start", fromSeq: 0 }) });
      for (const [seq, data] of replayFrames.entries()) {
        socket.onmessage?.({ data: JSON.stringify({ type: "output", seq, data }) });
        expect(terminal.element?.style.visibility).toBe("hidden");
      }
      socket.onmessage?.({ data: JSON.stringify({ type: "replay-end", toSeq: replayFrames.length - 1 }) });
    });

    expect(terminal.element?.style.visibility).toBe("hidden");
    expect(terminal.write).toHaveBeenCalledWith(expect.stringContaining("OLD_CMATRIX_FRAME_A"));
    expect(terminal.write).toHaveBeenCalledWith("CURRENT_ECHO_OUTPUT\r\n");

    await act(async () => {
      terminal.flushWrites();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(terminal.element?.style.visibility).toBe("visible");
  });

  it("abandons a stalled cold replay without revealing historical output", async () => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    let stalledReplayTimeout: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation((handler, timeout, ...args) => {
      if (timeout === COLD_REPLAY_TIMEOUT_MS && typeof handler === "function") {
        stalledReplayTimeout = () => handler(...args);
        return COLD_REPLAY_TIMEOUT_MS as unknown as ReturnType<typeof window.setTimeout>;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    });
    try {
      const view = render(
        <TerminalPane
          paneId="pane-stalled-cold-replay-test"
          cwd=""
          theme={theme}
          isFocused={false}
          isClosing={false}
          sessionId="main"
          shouldCacheOnUnmount={() => false}
          shouldDestroyOnUnmount={() => false}
          onFocus={() => {}}
        />,
      );

      await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
      const socket = WebSocketMock.instances[0]!;
      const terminal = createdTerminals[0]!;

      await act(async () => {
        socket.onmessage?.({
          data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 0 }),
        });
        socket.onmessage?.({ data: JSON.stringify({ type: "replay-start", fromSeq: 0 }) });
        socket.onmessage?.({
          data: JSON.stringify({ type: "output", seq: 0, data: "OLD_PRIVATE_FRAME\r\n" }),
        });
      });
      expect(stalledReplayTimeout).not.toBeNull();
      await act(async () => stalledReplayTimeout?.());

      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(terminal.reset).toHaveBeenCalledTimes(1);
      expect(terminal.element?.style.visibility).toBe("hidden");
      expect(view.getByText("Reconnecting terminal...")).toBeTruthy();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("records cold replay and cursor resume request/accept metadata without terminal content", async () => {
    render(
      <TerminalPane
        paneId="pane-replay-telemetry-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        sessionId="main"
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const firstSocket = WebSocketMock.instances[0]!;
    await act(async () => {
      firstSocket.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 12 }),
      });
    });
    expect(mockedCapturePostHogEvent).toHaveBeenCalledWith("shell_terminal_ws", expect.objectContaining({
      event: "attached",
      replayMode: "cold-replay",
      requestedSeq: 0,
      acceptedSeq: 12,
    }));

    await act(async () => {
      firstSocket.onclose?.();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(2));
    const reconnectSocket = WebSocketMock.instances[1]!;
    await act(async () => {
      reconnectSocket.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 12 }),
      });
    });
    expect(mockedCapturePostHogEvent).toHaveBeenCalledWith("shell_terminal_ws", expect.objectContaining({
      event: "attached",
      replayMode: "cursor-resume",
      requestedSeq: 12,
      acceptedSeq: 12,
    }));

    const telemetryPayloads = mockedCapturePostHogEvent.mock.calls.map(([, payload]) => payload);
    expect(telemetryPayloads).not.toContainEqual(expect.objectContaining({ data: expect.anything() }));
  });

  it("records cursor-resume metadata when a cached canonical socket finishes connecting", async () => {
    const cached = createCachedTerminal();
    stubWs.readyState = WebSocketMock.CONNECTING;
    restorePlan.current = {
      cached: {
        terminal: cached.terminal,
        fitAddon: { fit: vi.fn() },
        webglAddon: null,
        searchAddon: null,
        ws: stubWs,
        lastSeq: 23,
        hasReplayCursor: true,
        sessionId: "main",
      },
      reuseTerminal: true,
      reuseSocket: true,
      sessionId: "main",
      lastSeq: 23,
      hasReplayCursor: true,
    };

    render(
      <TerminalPane
        paneId="pane-cached-connecting-telemetry-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(stubWs.onmessage).not.toBeNull());
    await act(async () => {
      stubWs.readyState = WebSocketMock.OPEN;
      stubWs.onopen?.();
      stubWs.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 23 }),
      });
    });

    expect(mockedCapturePostHogEvent).toHaveBeenCalledWith("shell_terminal_ws", expect.objectContaining({
      event: "attached",
      replayMode: "cursor-resume",
      requestedSeq: 23,
      acceptedSeq: 23,
    }));
    expect(cached.terminal.element.style.visibility).toBe("visible");
  });

  it("resumes from the next accepted sequence and renders missed output once", async () => {
    render(
      <TerminalPane
        paneId="pane-missed-output-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        sessionId="main"
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const firstSocket = WebSocketMock.instances[0]!;
    const terminal = createdTerminals[0]!;
    await act(async () => {
      firstSocket.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 40 }),
      });
      firstSocket.onmessage?.({ data: JSON.stringify({ type: "output", seq: 40, data: "before-drop\r\n" }) });
      firstSocket.onclose?.();
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(2));
    const reconnectSocket = WebSocketMock.instances[1]!;
    expect(new URL(reconnectSocket.url).searchParams.get("fromSeq")).toBe("41");
    expect(terminal.element?.style.visibility).toBe("visible");
    await act(async () => {
      reconnectSocket.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 41 }),
      });
      reconnectSocket.onmessage?.({ data: JSON.stringify({ type: "output", seq: 41, data: "missed-once\r\n" }) });
    });

    expect(terminal.write.mock.calls.filter(([data]) => data === "before-drop\r\n")).toHaveLength(1);
    expect(terminal.write.mock.calls.filter(([data]) => data === "missed-once\r\n")).toHaveLength(1);
  });

  it("preserves the xterm buffer and replay cursor across cached tab switching", async () => {
    const props = {
      paneId: "pane-cached-replay-test",
      cwd: "",
      theme,
      isFocused: false,
      isClosing: false,
      sessionId: "main",
      shouldCacheOnUnmount: () => true,
      shouldDestroyOnUnmount: () => false,
      onFocus: () => {},
    } satisfies Parameters<typeof TerminalPane>[0];
    const firstMount = render(<TerminalPane {...props} />);

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    await waitFor(() => expect(createdWebglAddons).toHaveLength(1));
    const firstSocket = WebSocketMock.instances[0]!;
    const terminal = createdTerminals[0]!;
    await act(async () => {
      firstSocket.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 7 }),
      });
      firstSocket.onmessage?.({ data: JSON.stringify({ type: "output", seq: 7, data: "cached-output\r\n" }) });
    });
    await act(async () => {
      firstMount.unmount();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockedCacheTerminal).toHaveBeenCalled());
    const cachedEntry = mockedCacheTerminal.mock.calls.at(-1)![1];
    expect(cachedEntry.terminal).toBe(terminal);
    expect(cachedEntry.lastSeq).toBe(8);
    expect(cachedEntry.hasReplayCursor).toBe(true);
    expect(mockedCacheTerminal.mock.calls.at(-1)![2]).toEqual({ retainSocket: false });

    restorePlan.current = {
      cached: {
        terminal: cachedEntry.terminal,
        fitAddon: cachedEntry.fitAddon,
        webglAddon: null,
        searchAddon: cachedEntry.searchAddon,
        ws: stubWs,
        lastSeq: cachedEntry.lastSeq,
        hasReplayCursor: cachedEntry.hasReplayCursor,
        sessionId: cachedEntry.sessionId,
      },
      reuseTerminal: true,
      reuseSocket: false,
      sessionId: "main",
      lastSeq: 8,
      hasReplayCursor: true,
    };

    render(<TerminalPane {...props} />);
    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(2));

    expect(createdTerminals).toHaveLength(1);
    expect(terminal.write.mock.calls.filter(([data]) => data === "cached-output\r\n")).toHaveLength(1);
    expect(new URL(WebSocketMock.instances[1]!.url).searchParams.get("fromSeq")).toBe("8");
  });

  it("detaches and restores a suspended canonical pane with replay and current dimensions", async () => {
    const props = {
      paneId: "pane-suspension-lifecycle-test",
      cwd: "",
      theme,
      isFocused: false,
      isClosing: false,
      sessionId: "main",
      shouldCacheOnUnmount: () => true,
      shouldDestroyOnUnmount: () => false,
      onFocus: () => {},
    } satisfies Parameters<typeof TerminalPane>[0];
    useActualRestorePlan.current = true;
    const firstMount = render(<TerminalPane {...props} />);

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    await waitFor(() => expect(createdWebglAddons).toHaveLength(1));
    const firstSocket = WebSocketMock.instances[0]!;
    await waitFor(() => expect(firstSocket.onmessage).not.toBeNull());
    const terminal = createdTerminals[0]!;
    await act(async () => {
      firstMount.unmount();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockedCacheTerminal).toHaveBeenCalled());
    const cachedEntry = mockedCacheTerminal.mock.calls.at(-1)![1];
    expect(cachedEntry.terminal).toBe(terminal);
    expect(cachedEntry.lastSeq).toBe(0);
    expect(cachedEntry.hasReplayCursor).toBe(false);
    expect(mockedCacheTerminal.mock.calls.at(-1)![2]).toEqual({ retainSocket: false });
    expect(firstSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "detach" }));
    expect(firstSocket.close).toHaveBeenCalledOnce();

    render(<TerminalPane {...props} />);
    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(2));

    expect(createdTerminals).toHaveLength(1);
    const restoredSocket = WebSocketMock.instances[1]!;
    expect(new URL(restoredSocket.url).searchParams.get("fromSeq")).toBe("0");

    await act(async () => {
      restoredSocket.onmessage?.({
        data: JSON.stringify({ type: "attached", session: "main", state: "running", fromSeq: 0 }),
      });
      restoredSocket.onmessage?.({ data: JSON.stringify({ type: "replay-start", fromSeq: 0 }) });
      restoredSocket.onmessage?.({
        data: JSON.stringify({ type: "output", seq: 0, data: "replayed-after-restore\r\n" }),
      });
      restoredSocket.onmessage?.({ data: JSON.stringify({ type: "canonical-size", cols: 132, rows: 36 }) });
      restoredSocket.onmessage?.({ data: JSON.stringify({ type: "replay-end", toSeq: 0 }) });
    });

    expect(terminal.write.mock.calls.filter(([data]) => data === "replayed-after-restore\r\n")).toHaveLength(1);
    expect(terminal.resize).toHaveBeenLastCalledWith(132, 36);
  });

  it.each([0, 60])("uses attached fromSeq %i as the reconnect cursor before output arrives", async (fromSeq) => {
    render(
      <TerminalPane
        paneId="pane-attached-cursor-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        sessionId="main"
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const firstSocket = WebSocketMock.instances[0]!;

    await act(async () => {
      firstSocket.onmessage?.({
        data: JSON.stringify({
          type: "attached",
          session: "main",
          state: "running",
          fromSeq,
        }),
      });
      firstSocket.onclose?.();
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(2));
    const reconnectUrl = new URL(WebSocketMock.instances[1]!.url);
    expect(reconnectUrl.pathname).toBe("/ws/terminal/session");
    expect(reconnectUrl.searchParams.get("session")).toBe("main");
    expect(reconnectUrl.searchParams.get("fromSeq")).toBe(String(fromSeq));
  });
});
