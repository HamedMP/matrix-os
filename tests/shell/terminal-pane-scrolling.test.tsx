// @vitest-environment jsdom
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = `tws_${"a".repeat(32)}`;
const TAB_ID = `tt_${"b".repeat(32)}`;
const TERMINAL_REF_KEY = `${WORKSPACE_ID}:${TAB_ID}`;
const TERMINAL_REF = { workspaceId: WORKSPACE_ID, tabId: TAB_ID };

function attachedFrame(nextSeq: number, canonicalSize = { cols: 120, rows: 42 }, revision = 1) {
  return { type: "attached", terminalRef: TERMINAL_REF, canonicalSize, revision, nextSeq };
}

function outputFrame(seq: number, data: string, revision = 1) {
  return { type: "output", terminalRef: TERMINAL_REF, revision, seq, data };
}

function replayStartFrame(fromSeq: number) {
  return { type: "replay-start", terminalRef: TERMINAL_REF, revision: 1, fromSeq };
}

function replayEndFrame(nextSeq: number, toSeq?: number) {
  return { type: "replay-end", terminalRef: TERMINAL_REF, revision: 1, nextSeq, ...(toSeq === undefined ? {} : { toSeq }) };
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
    attachCustomKeyEventHandler = vi.fn();
    clearSelection = vi.fn();
    getSelection = vi.fn(() => "");
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
      resize: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn(),
      clearSelection: vi.fn(),
      getSelection: vi.fn(() => ""),
      scrollToBottom: vi.fn(),
    },
    viewport,
  };
}

describe("TerminalPane scrolling", () => {
  beforeEach(() => {
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

  it("attaches browser terminal tabs as soft clients with proposed dimensions", async () => {
    render(
      <TerminalPane
        paneId="pane-hard-attach"
        cwd=""
        theme={theme}
        isFocused
        sessionId={TERMINAL_REF_KEY}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    expect(buildAuthenticatedWebSocketUrl).toHaveBeenCalledWith(
      "/ws/terminal/tab",
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        tabId: TAB_ID,
        client: "browser",
        cols: "120",
        rows: "42",
      }),
    );
    expect(createdFitAddons[0].proposeDimensions).toHaveBeenCalled();
    expect(createdFitAddons[0].fit).not.toHaveBeenCalled();
    expect(createdTerminals[0].resize).not.toHaveBeenCalled();
  });

  it("keeps the focused web terminal attachment healthy", async () => {
    render(
      <TerminalPane
        paneId="pane-heartbeat"
        cwd=""
        theme={theme}
        isFocused
        sessionId={TERMINAL_REF_KEY}
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

  it("renders the durable observer snapshot for a terminal tab", async () => {
    render(
      <TerminalPane
        paneId="pane-presentation-reset"
        cwd=""
        theme={theme}
        isFocused
        sessionId={TERMINAL_REF_KEY}
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
        data: JSON.stringify(attachedFrame(0)),
      });
      socket.onmessage?.({
        data: JSON.stringify({
          type: "snapshot",
          terminalRef: TERMINAL_REF,
          revision: 1,
          seq: 0,
          ansi: "durable snapshot",
          canonicalSize: { cols: 120, rows: 42 },
          viewport: { top: 0, rows: 42 },
        }),
      });
    });

    expect(terminal.write).toHaveBeenCalledWith("durable snapshot");
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
        sessionId={TERMINAL_REF_KEY}
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
      "/ws/terminal/tab",
      expect.objectContaining({ client: "browser", cols: "500", rows: "200" }),
    );
  });

  it("keeps mobile canonical sessions soft", async () => {
    render(
      <TerminalPane
        paneId="pane-soft-attach"
        cwd=""
        theme={theme}
        isFocused
        sessionId={TERMINAL_REF_KEY}
        isClosing={false}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        suppressNativeKeyboard
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    expect(buildAuthenticatedWebSocketUrl).toHaveBeenCalledWith(
      "/ws/terminal/tab",
      expect.objectContaining({ workspaceId: WORKSPACE_ID, tabId: TAB_ID, client: "mobile" }),
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
        sessionId={TERMINAL_REF_KEY}
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

    expect(stubWs.send).toHaveBeenCalledWith(JSON.stringify({
      type: "resize",
      terminalRef: TERMINAL_REF,
      mode: "soft",
      size: { cols: 154, rows: 51 },
    }));
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
        sessionId={TERMINAL_REF_KEY}
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
        data: JSON.stringify({ type: "canonical-size", terminalRef: TERMINAL_REF, revision: 2, canonicalSize: { cols: 146, rows: 47 } }),
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
        sessionId={TERMINAL_REF_KEY}
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
      "/ws/terminal/tab",
      expect.objectContaining({ workspaceId: WORKSPACE_ID, tabId: TAB_ID, client: "mobile" }),
    );

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify(attachedFrame(0, { cols: 140, rows: 40 })),
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
        data: JSON.stringify(outputFrame(1, `${longLsRow}\r\n$ `)),
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
    expect(stubWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "input", terminalRef: TERMINAL_REF, data: "x" }));

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
        data: JSON.stringify({ type: "canonical-size", terminalRef: TERMINAL_REF, revision: 2, canonicalSize: { cols: 132, rows: 36 } }),
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
        sessionId: TERMINAL_REF_KEY,
      },
      reuseTerminal: true,
      reuseSocket: true,
      sessionId: TERMINAL_REF_KEY,
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
        sessionId={TERMINAL_REF_KEY}
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
        sessionId: TERMINAL_REF_KEY,
      },
      reuseTerminal: true,
      reuseSocket: true,
      sessionId: TERMINAL_REF_KEY,
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
        sessionId={TERMINAL_REF_KEY}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(container.querySelector(".xterm")).toBe(cached.terminal.element));
    await waitFor(() => expect(cached.terminal.refresh).toHaveBeenCalledWith(0, 23));
    await waitFor(() => expect(createdWebglAddons).toHaveLength(1));

    expect(createdTerminals).toHaveLength(0);
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(cached.terminal.loadAddon).toHaveBeenCalledWith(createdWebglAddons[0]);
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
        sessionId={TERMINAL_REF_KEY}
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
        sessionId={TERMINAL_REF_KEY}
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
        sessionId: TERMINAL_REF_KEY,
      },
      reuseTerminal: true,
      reuseSocket: true,
      sessionId: TERMINAL_REF_KEY,
      lastSeq: 0,
      hasReplayCursor: false,
    };
    render(
      <TerminalPane
        paneId="pane-cached-light-background"
        cwd=""
        theme={lightTheme}
        isFocused={false}
        sessionId={TERMINAL_REF_KEY}
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
        sessionId={TERMINAL_REF_KEY}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const url = new URL(WebSocketMock.instances[0]!.url);

    expect(url.pathname).toBe("/ws/terminal/tab");
    expect(url.searchParams.get("workspaceId")).toBe(WORKSPACE_ID);
    expect(url.searchParams.get("tabId")).toBe(TAB_ID);
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
      sessionId: TERMINAL_REF_KEY,
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
        data: JSON.stringify(attachedFrame(0)),
      });
      restoredSocket.onmessage?.({ data: JSON.stringify(replayStartFrame(0)) });
      restoredSocket.onmessage?.({
        data: JSON.stringify(outputFrame(0, "retained-before-refresh\r\n")),
      });
      restoredSocket.onmessage?.({ data: JSON.stringify(replayEndFrame(1, 0)) });
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
        sessionId={TERMINAL_REF_KEY}
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
        data: JSON.stringify(attachedFrame(0)),
      });
      socket.onmessage?.({ data: JSON.stringify(replayStartFrame(0)) });
      for (const [seq, data] of replayFrames.entries()) {
        socket.onmessage?.({ data: JSON.stringify(outputFrame(seq, data)) });
        expect(terminal.element?.style.visibility).toBe("hidden");
      }
      socket.onmessage?.({ data: JSON.stringify(replayEndFrame(replayFrames.length, replayFrames.length - 1)) });
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
          sessionId={TERMINAL_REF_KEY}
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
          data: JSON.stringify(attachedFrame(0)),
        });
        socket.onmessage?.({ data: JSON.stringify(replayStartFrame(0)) });
        socket.onmessage?.({
          data: JSON.stringify(outputFrame(0, "OLD_PRIVATE_FRAME\r\n")),
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
        sessionId={TERMINAL_REF_KEY}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const firstSocket = WebSocketMock.instances[0]!;
    await act(async () => {
      firstSocket.onmessage?.({
        data: JSON.stringify(attachedFrame(12)),
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
        data: JSON.stringify(attachedFrame(12)),
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
        sessionId: TERMINAL_REF_KEY,
      },
      reuseTerminal: true,
      reuseSocket: true,
      sessionId: TERMINAL_REF_KEY,
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
        data: JSON.stringify(attachedFrame(23)),
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
        sessionId={TERMINAL_REF_KEY}
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
        data: JSON.stringify(attachedFrame(40)),
      });
      firstSocket.onmessage?.({ data: JSON.stringify(outputFrame(40, "before-drop\r\n")) });
      firstSocket.onclose?.();
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(2));
    const reconnectSocket = WebSocketMock.instances[1]!;
    expect(new URL(reconnectSocket.url).searchParams.get("fromSeq")).toBe("41");
    expect(terminal.element?.style.visibility).toBe("visible");
    await act(async () => {
      reconnectSocket.onmessage?.({
        data: JSON.stringify(attachedFrame(41)),
      });
      reconnectSocket.onmessage?.({ data: JSON.stringify(outputFrame(41, "missed-once\r\n")) });
    });

    expect(terminal.write.mock.calls.filter(([data]) => data === "before-drop\r\n")).toHaveLength(1);
    expect(terminal.write.mock.calls.filter(([data]) => data === "missed-once\r\n")).toHaveLength(1);
  });

  it("accepts a lower revision watermark from a replacement socket", async () => {
    render(
      <TerminalPane
        paneId="pane-revision-reconnect-test"
        cwd=""
        theme={theme}
        isFocused={false}
        isClosing={false}
        sessionId={TERMINAL_REF_KEY}
        shouldCacheOnUnmount={() => false}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(1));
    const firstSocket = WebSocketMock.instances[0]!;
    const terminal = createdTerminals[0]!;
    await act(async () => {
      firstSocket.onmessage?.({ data: JSON.stringify(attachedFrame(0, undefined, 10)) });
      firstSocket.onmessage?.({ data: JSON.stringify(outputFrame(0, "before-reconnect\r\n", 10)) });
      firstSocket.onclose?.();
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(2));
    const reconnectSocket = WebSocketMock.instances[1]!;
    await act(async () => {
      reconnectSocket.onmessage?.({ data: JSON.stringify(attachedFrame(1, undefined, 1)) });
      reconnectSocket.onmessage?.({ data: JSON.stringify(outputFrame(1, "after-reconnect\r\n", 1)) });
    });

    expect(terminal.write.mock.calls.filter(([data]) => data === "after-reconnect\r\n")).toHaveLength(1);
  });

  it("preserves the xterm buffer and replay cursor across cached tab switching", async () => {
    const props = {
      paneId: "pane-cached-replay-test",
      cwd: "",
      theme,
      isFocused: false,
      isClosing: false,
      sessionId: TERMINAL_REF_KEY,
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
        data: JSON.stringify(attachedFrame(7)),
      });
      firstSocket.onmessage?.({ data: JSON.stringify(outputFrame(7, "cached-output\r\n")) });
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
      sessionId: TERMINAL_REF_KEY,
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
      sessionId: TERMINAL_REF_KEY,
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
        data: JSON.stringify(attachedFrame(0, { cols: 132, rows: 36 })),
      });
      restoredSocket.onmessage?.({ data: JSON.stringify(replayStartFrame(0)) });
      restoredSocket.onmessage?.({
        data: JSON.stringify(outputFrame(0, "replayed-after-restore\r\n")),
      });
      restoredSocket.onmessage?.({ data: JSON.stringify(replayEndFrame(1, 0)) });
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
        sessionId={TERMINAL_REF_KEY}
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
          ...attachedFrame(fromSeq),
        }),
      });
      firstSocket.onclose?.();
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(WebSocketMock.instances).toHaveLength(2));
    const reconnectUrl = new URL(WebSocketMock.instances[1]!.url);
    expect(reconnectUrl.pathname).toBe("/ws/terminal/tab");
    expect(reconnectUrl.searchParams.get("workspaceId")).toBe(WORKSPACE_ID);
    expect(reconnectUrl.searchParams.get("tabId")).toBe(TAB_ID);
    expect(reconnectUrl.searchParams.get("fromSeq")).toBe(String(fromSeq));
  });
});
