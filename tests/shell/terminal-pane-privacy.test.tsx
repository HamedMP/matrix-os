// @vitest-environment jsdom
import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stubTerminal = vi.hoisted(() => ({
  element: null as HTMLElement | null,
  focus: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
  cols: 80,
  rows: 24,
  options: {} as Record<string, unknown>,
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onResize: vi.fn(() => ({ dispose: vi.fn() })),
  attachCustomKeyEventHandler: vi.fn(),
  clearSelection: vi.fn(),
  getSelection: vi.fn(() => ""),
}));

const stubWs = vi.hoisted(() => ({
  readyState: 1,
  send: vi.fn(),
  close: vi.fn(),
  onopen: null as (() => void) | null,
  onmessage: null as ((event: unknown) => void) | null,
  onclose: null as (() => void) | null,
  onerror: null as (() => void) | null,
}));

vi.mock("../../shell/src/components/terminal/terminal-cache.js", () => ({
  cacheTerminal: vi.fn(),
  getCached: vi.fn(() => null),
  removeCached: vi.fn(),
  hasCached: vi.fn(() => false),
}));

vi.mock("../../shell/src/components/terminal/terminal-restore.js", () => ({
  getCachedTerminalRestorePlan: vi.fn(() => ({
    cached: {
      terminal: stubTerminal,
      fitAddon: { fit: vi.fn() },
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
  })),
  discardStaleCachedTerminal: vi.fn(),
  closeStaleCachedSocket: vi.fn(),
}));

vi.mock("../../shell/src/components/terminal/terminal-appearance.js", () => ({
  applyTerminalAppearance: vi.fn(),
}));

vi.mock("@/stores/terminal-settings", () => {
  const state = {
    themeId: "system",
    fontSize: 13,
    fontFamily: "JetBrains Mono",
    ligatures: true,
    cursorStyle: "block",
    smoothScroll: false,
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

describe("TerminalPane session replay privacy", () => {
  beforeEach(() => {
    stubTerminal.element = document.createElement("div");
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    if (typeof globalThis.requestAnimationFrame !== "function") {
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame;
    }
  });

  it("marks the xterm container with ph-no-capture so recordings never include terminal output", () => {
    const { container } = render(
      <TerminalPane
        paneId="pane-privacy-test"
        cwd=""
        theme={theme}
        isFocused={false}
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => true}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );

    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.classList.contains("ph-no-capture")).toBe(true);
  });
});
