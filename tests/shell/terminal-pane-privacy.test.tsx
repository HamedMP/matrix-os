// @vitest-environment jsdom
import React from "react";
import { render, waitFor } from "@testing-library/react";
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
const BRACKETED_PASTE_OPEN = "\u001b[200~";
const BRACKETED_PASTE_CLOSE = "\u001b[201~";

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
    stubWs.readyState = 1;
    stubWs.send.mockClear();
    stubWs.close.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      path: "projects/.matrix-terminal-pastes/2026-07-07/upload.png",
      terminalPath: "/home/matrix/home/projects/.matrix-terminal-pastes/2026-07-07/upload.png",
      size: 12,
      mimeType: "image/png",
    }))));
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

  it("captures pasted image files before the browser can navigate and pastes the uploaded terminal path", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const bubbleSpy = vi.fn();
    host.addEventListener("paste", bubbleSpy);
    const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], "screen shot.png", {
      type: "image/png",
    });
    const { container, unmount } = render(
      <TerminalPane
        paneId="pane-image-paste"
        cwd="projects"
        theme={theme}
        isFocused={false}
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => true}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
      { container: host },
    );
    await Promise.resolve();
    const root = container.firstElementChild as HTMLElement;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        files: [file],
        types: ["Files"],
        getData: vi.fn(() => ""),
      },
    });

    const dispatchResult = root.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(bubbleSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/terminal/sessions/main/paste-assets"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "image/png",
            "X-Matrix-Filename": "screen shot.png",
          }),
        }),
      );
    });
    await waitFor(() => {
      expect(stubWs.send).toHaveBeenCalledWith(JSON.stringify({
        type: "input",
        data: `${BRACKETED_PASTE_OPEN}/home/matrix/home/projects/.matrix-terminal-pastes/2026-07-07/upload.png${BRACKETED_PASTE_CLOSE}`,
      }));
    });
    unmount();
    host.remove();
  });

  it("lets text-only paste continue through xterm without uploading", async () => {
    const { container } = render(
      <TerminalPane
        paneId="pane-text-paste"
        cwd="projects"
        theme={theme}
        isFocused={false}
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => true}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await Promise.resolve();
    const root = container.firstElementChild as HTMLElement;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [],
        files: [],
        types: ["text/plain"],
        getData: vi.fn(() => "hello"),
      },
    });

    const dispatchResult = root.dispatchEvent(event);

    expect(dispatchResult).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("captures dropped image files and does not close or reconnect the terminal socket on upload failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "upload_failed", message: "Request failed" } }),
      { status: 500 },
    )));
    const file = new File([Uint8Array.from([0xff, 0xd8, 0xff])], "photo.jpg", {
      type: "image/jpeg",
    });
    const { container } = render(
      <TerminalPane
        paneId="pane-image-drop"
        cwd="projects"
        theme={theme}
        isFocused={false}
        sessionId="main"
        isClosing={false}
        shouldCacheOnUnmount={() => true}
        shouldDestroyOnUnmount={() => false}
        onFocus={() => {}}
      />,
    );
    await Promise.resolve();
    const root = container.firstElementChild as HTMLElement;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        items: [{ kind: "file", type: "image/jpeg", getAsFile: () => file }],
        files: [file],
        types: ["Files"],
      },
    });

    const dispatchResult = root.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(stubWs.close).not.toHaveBeenCalled();
    expect(stubWs.send).not.toHaveBeenCalledWith(expect.stringContaining("photo.jpg"));
  });
});
