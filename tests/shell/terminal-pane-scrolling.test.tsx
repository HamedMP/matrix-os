// @vitest-environment jsdom
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createdTerminals = vi.hoisted(() => [] as Array<{
  options: Record<string, unknown>;
  element: HTMLElement | null;
  viewport: HTMLElement | null;
  focus: ReturnType<typeof vi.fn>;
}>);

const createdFitAddons = vi.hoisted(() => [] as Array<{
  fit: ReturnType<typeof vi.fn>;
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
      fitAddon: { fit: ReturnType<typeof vi.fn> };
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

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    element: HTMLElement | null = null;
    viewport: HTMLElement | null = null;
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    parser = { registerOscHandler: vi.fn() };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      createdTerminals.push(this);
    }

    loadAddon = vi.fn();
    focus = vi.fn();
    refresh = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
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
      root.appendChild(viewport);
      container.appendChild(root);
      this.element = root;
      this.viewport = viewport;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn();

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

vi.mock("../../shell/src/components/terminal/terminal-cache.js", () => ({
  cacheTerminal: vi.fn(),
  getCached: vi.fn(() => null),
  removeCached: vi.fn(),
  hasCached: vi.fn(() => false),
}));

vi.mock("../../shell/src/components/terminal/terminal-restore.js", () => ({
  getCachedTerminalRestorePlan: vi.fn(() => restorePlan.current),
  discardStaleCachedTerminal: vi.fn(),
  closeStaleCachedSocket: vi.fn(),
}));

vi.mock("../../shell/src/components/terminal/terminal-appearance.js", () => ({
  applyTerminalAppearance: vi.fn(),
}));

vi.mock("@/lib/websocket-auth", () => ({
  buildAuthenticatedWebSocketUrl,
}));

vi.mock("@/lib/socket-health", () => ({
  createSocketHealth: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    pingNow: vi.fn(),
    receivedPong: vi.fn(),
  })),
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
import { cacheTerminal } from "../../shell/src/components/terminal/terminal-cache.js";

const mockedCacheTerminal = vi.mocked(cacheTerminal);

const theme = {
  mode: "dark",
  colors: { background: "#101820", foreground: "#f0efe7", primary: "#33aaff" },
  fonts: {},
} as unknown as Parameters<typeof TerminalPane>[0]["theme"];

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
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
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    globalThis.WebSocket = WebSocketMock as unknown as typeof WebSocket;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame;
    stubWs.send.mockReset();
    stubWs.close.mockReset();
    mockedCacheTerminal.mockClear();
    WebSocketMock.instances.length = 0;
    buildAuthenticatedWebSocketUrl.mockClear();
    Reflect.deleteProperty(window, "visualViewport");
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
