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

const stubWs = vi.hoisted(() => ({
  readyState: 1,
  send: vi.fn(),
  close: vi.fn(),
  onopen: null as (() => void) | null,
  onmessage: null as ((event: unknown) => void) | null,
  onclose: null as (() => void) | null,
  onerror: null as (() => void) | null,
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
        write: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
        onData: ReturnType<typeof vi.fn>;
        onResize: ReturnType<typeof vi.fn>;
        attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
        clearSelection: ReturnType<typeof vi.fn>;
        getSelection: ReturnType<typeof vi.fn>;
      };
      fitAddon: { fit: ReturnType<typeof vi.fn> };
      webglAddon: null;
      searchAddon: null;
      ws: typeof stubWs;
      lastSeq: number;
      sessionId: string;
    },
    reuseTerminal: false,
    reuseSocket: false,
    sessionId: null as string | null,
    lastSeq: 0,
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
    write = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    clearSelection = vi.fn();
    getSelection = vi.fn(() => "");
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
  buildAuthenticatedWebSocketUrl: vi.fn(() => Promise.resolve("ws://localhost/ws/terminal")),
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
  readyState = 1;
  send = stubWs.send;
  close = stubWs.close;
  onopen: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {}
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
      write: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn(),
      clearSelection: vi.fn(),
      getSelection: vi.fn(() => ""),
    },
    viewport,
  };
}

describe("TerminalPane scrolling", () => {
  beforeEach(() => {
    createdTerminals.length = 0;
    createdFitAddons.length = 0;
    restorePlan.current = {
      cached: null,
      reuseTerminal: false,
      reuseSocket: false,
      sessionId: null,
      lastSeq: 0,
    };
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    globalThis.WebSocket = WebSocketMock as unknown as typeof WebSocket;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame;
    stubWs.send.mockReset();
    stubWs.close.mockReset();
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
        sessionId: "cached-terminal",
      },
      reuseTerminal: true,
      reuseSocket: true,
      sessionId: "cached-terminal",
      lastSeq: 0,
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
  });
});
