// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

const paneGridSpy = vi.fn();

vi.mock("../../shell/src/components/terminal/PaneGrid.js", () => ({
  PaneGrid: (props: unknown) => {
    paneGridSpy(props);
    return null;
  },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    mode: "dark",
    colors: { background: "#101820", foreground: "#f0efe7", primary: "#33aaff" },
    fonts: {},
  }),
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
    setThemeId: vi.fn(),
    setFontSize: vi.fn(),
    setFontFamily: vi.fn(),
    setLigatures: vi.fn(),
    setCursorStyle: vi.fn(),
    setSmoothScroll: vi.fn(),
    setCursorBlink: vi.fn(),
  };

  return {
    useTerminalSettings: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

import { TerminalApp } from "../../shell/src/components/terminal/TerminalApp.js";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe("TerminalApp", () => {
  beforeEach(() => {
    paneGridSpy.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a canvas-provided terminal session without creating a fresh layout tab", async () => {
    render(<TerminalApp initialSessionId="canvas-session-123" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Canvas Terminal")).toBeTruthy();
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };

    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: "canvas-session-123",
    });
  });

  it("keeps the mobile terminal chrome clear of cwd badges that overlap zellij tabs", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("~/projects")).toBeNull();
    expect(screen.getByTitle("New tab (Ctrl+Shift+T)")).toBeTruthy();
  });

  it("keeps mobile terminal accessory keys theme-aligned and keyboard safe", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const keyBar = screen.getByTestId("terminal-key-bar");
    expect(keyBar.style.position).toBe("sticky");
    expect(keyBar.style.bottom).toBe("var(--matrix-terminal-keybar-bottom)");
    expect(keyBar.style.getPropertyValue("--matrix-terminal-keybar-bottom")).toBe("env(keyboard-inset-height, 0px)");
    expect(keyBar.style.background).toContain("16, 24, 32");
    expect(screen.getByRole("button", { name: "Control C" }).style.color).toContain("240, 239, 231");
    expect(screen.getByRole("button", { name: "Enter" })).toBeTruthy();
  });

  it("does not let mobile terminal clients take ownership of the remote zellij size", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      allowRemoteResize: false,
      suppressNativeKeyboard: true,
    });
  });

  it("places the new-tab control immediately after the last terminal tab", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New tab" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const tablist = screen.getByRole("tablist", { name: "Terminal tabs" });
    const tabs = screen.getAllByRole("tab");
    const newTabButton = screen.getByRole("button", { name: "New tab" });

    expect(tabs).toHaveLength(2);
    expect(tablist.children[0]).toBe(tabs[0]);
    expect(tablist.children[1]).toBe(tabs[1]);
    expect(tablist.children[2]).toBe(newTabButton);
  });

  it("opens zellij-backed shell sessions from the new-tab control", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New tab" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const createCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([input, init]: [RequestInfo | URL, RequestInit | undefined]) => (
        String(input).endsWith("/api/terminal/sessions") &&
        init?.method === "POST" &&
        typeof init.body === "string"
      ))
      .map(([, init]: [RequestInfo | URL, RequestInit]) => JSON.parse(String(init.body)) as { name: string });

    expect(createCalls.some((body) => /^zellij-/.test(body.name))).toBe(true);
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^zellij-/),
      },
    });
  });

  it("keeps the tab close button pinned to the tab edge for short labels", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const closeButton = screen.getByRole("button", { name: "Close tab" });

    expect(closeButton.style.marginLeft).toBe("auto");
    expect(closeButton.style.flexShrink).toBe("0");
  });

  it("opens the left terminal panel on Shells first", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const railButtons = screen.getAllByRole("button", {
      name: /^(Sessions|Projects|Shells|Files)$/,
    });

    expect(railButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Shells",
      "Sessions",
      "Projects",
      "Files",
    ]);
    expect(screen.getByText("Shells")).toBeTruthy();
    expect(screen.getByLabelText("Search shells")).toBeTruthy();
  });

  it("fully removes the sidebar from layout flow when hidden", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTitle("Hide sidebar (Ctrl+Shift+B)"));

    const openButton = screen.getByTitle("Open sidebar (Ctrl+Shift+B)");
    expect(openButton.parentElement?.className).toContain("absolute");
    expect(openButton.parentElement?.style.width).not.toBe("44px");
  });

  it("opens zellij-backed shell sessions from Ctrl+Shift+T", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("application", { name: "Terminal" }), {
        key: "T",
        ctrlKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^zellij-/),
      },
    });
  });

  it("opens zellij-backed shell sessions from the empty terminal state", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New Terminal" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: {
        sessionId: expect.stringMatching(/^zellij-/),
      },
    });
  });

  it("copies a local CLI attach command when clicking a shell session name", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessions: [{ name: "main", status: "active", attachedClients: 1, tabs: [] }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Shells" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy attach command for main" }));
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("matrix shell connect main");
  });

  it("does not persist the mobile-forced sidebar state into shared terminal layout", async () => {
    render(<TerminalApp mobile initialSessionId="main" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    const layoutSave = vi.mocked(global.fetch).mock.calls.find(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));
    expect(layoutSave).toBeTruthy();
    expect(JSON.parse(String(layoutSave?.[1]?.body))).not.toHaveProperty("sidebarOpen");
  });

  it("starts normal terminal tabs on the canonical main shell session", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree).toMatchObject({
      type: "pane",
      sessionId: "main",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "main", cwd: "projects" }),
      }),
    );
  });

  it("replaces saved legacy pty layouts with the canonical main shell session", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [{
              id: "legacy-tab",
              label: "projects",
              paneTree: {
                type: "pane",
                id: "legacy-pane",
                cwd: "projects",
                sessionId: "550e8400-e29b-41d4-a716-446655440000",
              },
            }],
            activeTabId: "legacy-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("main");
  });

  it("replaces mixed canonical and legacy pty layouts with the canonical main shell session", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [
              {
                id: "main-tab",
                label: "main",
                paneTree: {
                  type: "pane",
                  id: "main-pane",
                  cwd: "projects",
                  sessionId: "main",
                },
              },
              {
                id: "legacy-tab",
                label: "Legacy Zellij",
                paneTree: {
                  type: "pane",
                  id: "legacy-pane",
                  cwd: "projects",
                  sessionId: "550e8400-e29b-41d4-a716-446655440000",
                },
              },
            ],
            activeTabId: "legacy-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Legacy Zellij")).toBeNull();
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("main");
  });

  it("recreates saved canonical shell sessions before restoring a layout", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [{
              id: "bench-tab",
              label: "bench",
              paneTree: {
                type: "pane",
                id: "bench-pane",
                cwd: "projects",
                sessionId: "bench",
              },
            }],
            activeTabId: "bench-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/sessions"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "bench", cwd: "projects" }),
      }),
    );
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string };
    };
    expect(props.paneTree.sessionId).toBe("bench");
  });

  it("does not replace a legacy layout after unmount while ensuring the canonical session", async () => {
    let resolveSessions: ((value: { ok: boolean; json: () => Promise<{ sessions: Array<{ name: string }> }> }) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tabs: [{
              id: "legacy-tab",
              label: "projects",
              paneTree: {
                type: "pane",
                id: "legacy-pane",
                cwd: "projects",
                sessionId: "550e8400-e29b-41d4-a716-446655440000",
              },
            }],
            activeTabId: "legacy-tab",
          }),
        });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return new Promise((resolve) => {
          resolveSessions = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }));

    const { unmount } = render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsBeforeUnmount = paneGridSpy.mock.calls.length;

    unmount();
    await act(async () => {
      resolveSessions?.({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it("persists attached session ids in the saved layout", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(paneGridSpy).toHaveBeenCalled();

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };

    expect(props.paneTree.type).toBe("pane");

    act(() => {
      props.onSessionAttached(props.paneTree.id, "session-123");
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const layoutPutCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));

    expect(layoutPutCalls.length).toBeGreaterThan(0);
    const latestBody = layoutPutCalls.at(-1)?.[1]?.body;
    expect(typeof latestBody).toBe("string");
    expect(JSON.parse(latestBody as string)).toMatchObject({
      tabs: [
        {
          paneTree: {
            sessionId: "session-123",
          },
        },
      ],
    });
  });

  it("flushes attached session ids on pagehide before the debounce fires", async () => {
    render(<TerminalApp />);

    // Flush microtasks so async initLayout completes and setInitialized(true) propagates
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };

    act(() => {
      props.onSessionAttached(props.paneTree.id, "session-refresh");
    });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const layoutPutCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));

    expect(layoutPutCalls.length).toBeGreaterThan(0);
    const latestBody = layoutPutCalls.at(-1)?.[1]?.body;
    expect(typeof latestBody).toBe("string");
    expect(JSON.parse(latestBody as string)).toMatchObject({
      tabs: [
        {
          paneTree: {
            sessionId: "session-refresh",
          },
        },
      ],
    });
  });

  it("destroys a just-attached legacy pty session when the tab closes before layout state catches up", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };

    act(() => {
      props.onSessionAttached(props.paneTree.id, "550e8400-e29b-41d4-a716-446655440000");
    });

    fireEvent.click(screen.getByTitle("Close tab"));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const deleteCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/pty-sessions/550e8400-e29b-41d4-a716-446655440000") && init?.method === "DELETE"
    ));

    expect(deleteCalls.length).toBe(1);
  });

  it("creates toolbar zellij launches as canonical shell sessions", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Launch Zellij (Ctrl+Shift+Z)"));
      await Promise.resolve();
      await Promise.resolve();
    });

    const createCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input).includes("/api/terminal/sessions") &&
      init?.method === "POST" &&
      typeof init.body === "string" &&
      JSON.parse(init.body).name.startsWith("zellij-")
    ));
    expect(createCall).toBeTruthy();
    const body = JSON.parse(createCall?.[1]?.body as string) as { name: string; cwd: string };
    expect(body).toMatchObject({ cwd: "projects" });
    expect(body.name).toMatch(/^zellij-[a-z0-9]+$/);

    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { type: "pane"; sessionId?: string; startupCommand?: string };
    };
    expect(props.paneTree.sessionId).toBe(body.name);
    expect(props.paneTree.startupCommand).toBeUndefined();
  });

  it("cleans up a just-created zellij shell when unmounted before the tab is attached", async () => {
    let resolveCreate: ((value: { ok: boolean; status: number; json: () => Promise<{ name: string }> }) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method !== "POST" && init?.method !== "DELETE") {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main" }] }) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      if (url.includes("/api/terminal/sessions/") && init?.method === "DELETE") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    const { unmount } = render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Launch Zellij (Ctrl+Shift+Z)"));
      await Promise.resolve();
    });

    const createCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input).includes("/api/terminal/sessions") &&
      init?.method === "POST"
    ));
    expect(createCall).toBeTruthy();
    const name = JSON.parse(createCall?.[1]?.body as string).name as string;

    unmount();
    await act(async () => {
      resolveCreate?.({ ok: true, status: 200, json: async () => ({ name }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/terminal/sessions/${name}?force=1`),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("uses workspace sessions as the coding cockpit source of truth", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/sessions/sess_abc123/observe") && init?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ terminalSessionId: "term_observe_abc123" }) });
      }
      if (url.includes("/api/sessions/sess_abc123/takeover") && init?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ terminalSessionId: "term_owner_abc123" }) });
      }
      if (url.includes("/api/sessions/sess_abc123") && init?.method === "DELETE") {
        return Promise.resolve({ ok: true, json: async () => ({ session: { id: "sess_abc123", runtime: { status: "exited" } } }) });
      }
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ session: { id: "sess_copy", runtime: { status: "starting" } } }) });
      }
      if (url.includes("/api/sessions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [{
              id: "sess_abc123",
              kind: "agent",
              projectSlug: "repo",
              taskId: "task_abc123",
              worktreeId: "wt_abc123def456",
              agent: "codex",
              runtime: { status: "running" },
              nativeAttachCommand: ["zellij", "attach", "matrix-sess_abc123"],
              transcriptPath: "system/session-output/sess_abc123.jsonl",
            }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("sess_abc123")).toBeTruthy();
    expect(screen.getByText("running health")).toBeTruthy();
    expect(screen.getByText("zellij attach matrix-sess_abc123")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value: "task_abc123" } });
    expect(screen.getByText("sess_abc123")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /observe sess_abc123/i }));
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/sess_abc123/observe"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: { sessionId: "term_observe_abc123" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /take over sess_abc123/i }));
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/sess_abc123/takeover"),
      expect.objectContaining({ method: "POST" }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /duplicate sess_abc123/i }));
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions"),
      expect.objectContaining({ method: "POST" }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /kill sess_abc123/i }));
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/sess_abc123"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/terminal/pty-sessions"), expect.objectContaining({ method: "GET" }));
  });

  it("filters the Files sidebar tree by the search input", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { name: "package.json", type: "file", gitStatus: null },
            { name: "README.md", type: "file", gitStatus: null },
            {
              name: "src",
              type: "directory",
              gitStatus: null,
              expanded: false,
              children: [{ name: "app.tsx", type: "file", gitStatus: null, path: "projects/src/app.tsx" }],
            },
          ],
        });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Files" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("package.json")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "readme" } });
    });

    expect(screen.queryByText("package.json")).toBeNull();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.queryByText("src")).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "src" } });
    });

    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.getByText("app.tsx")).toBeTruthy();
    expect(screen.queryByText("README.md")).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "file" } });
    });

    expect(screen.getByText("No files match")).toBeTruthy();
    expect(screen.queryByText("package.json")).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "missing" } });
    });

    expect(screen.getByText("No files match")).toBeTruthy();
  });

  it("trims project search before filtering", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/projects")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ projects: [{ name: "matrix-os", path: "projects/matrix-os" }] }),
        });
      }
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Projects" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("matrix-os")).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "  matrix  " } });
    });

    expect(screen.getByText("matrix-os")).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "   " } });
    });

    expect(screen.getByText("matrix-os")).toBeTruthy();
  });

  it("manages canonical zellij shells from a dedicated sidebar surface", async () => {
    let mainDeleted = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions/main") && init?.method === "DELETE") {
        mainDeleted = true;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ name: "zellij-new", created: true }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              ...(mainDeleted ? [] : [{
                name: "main",
                status: "active",
                attachedClients: 1,
                tabs: [{ idx: 0, name: "dev", focused: true }],
              }]),
              {
              name: "bench",
              status: "degraded",
              attachedClients: 0,
              tabs: [{ idx: 0, name: "latency", focused: true }, { idx: 3, name: "load" }],
            }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Projects" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "does-not-carry-over" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Shells" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Search shells")).toHaveProperty("value", "");
    expect(screen.getByText("1 tab")).toBeTruthy();
    expect(screen.getByText("4 tabs")).toBeTruthy();
    expect(screen.getByText("0: dev")).toBeTruthy();
    expect(screen.getByText("0: latency")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open bench/i }));
    });
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: { sessionId: "bench" },
    });

    await act(async () => {
      const newButton = screen.getByRole("button", { name: "New" });
      fireEvent.click(newButton);
      fireEvent.click(newButton);
      await Promise.resolve();
    });
    const createCalls = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions") && init?.method === "POST"
    ));
    expect(createCalls).toHaveLength(1);

    await act(async () => {
      const deleteButton = screen.getByRole("button", { name: /delete main/i });
      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
      await Promise.resolve();
    });
    const deleteCalls = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions/main?force=1") && init?.method === "DELETE"
    ));
    expect(deleteCalls).toHaveLength(1);
    expect(screen.queryByText("0: dev")).toBeNull();
  });

  it("keeps the Shells sidebar synchronized after manual refresh", async () => {
    let revealBench = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: revealBench
              ? [{ name: "main", status: "active" }, { name: "bench", status: "active" }]
              : [{ name: "main", status: "active" }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: "Shells" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Copy attach command for main" })).toBeTruthy();
    expect(screen.queryByText("bench")).toBeNull();

    await act(async () => {
      revealBench = true;
      fireEvent.click(screen.getByTitle("Refresh"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("bench")).toBeTruthy();
  });

  it("keeps the last known Shells list visible during transient refresh failures", async () => {
    let shellListMode: "initial" | "fail" | "recover" = "initial";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        if (shellListMode === "fail") {
          shellListMode = "recover";
          return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: shellListMode === "recover"
              ? [{ name: "main", status: "active" }, { name: "bench", status: "active" }]
              : [{ name: "main", status: "active" }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: "Shells" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Copy attach command for main" })).toBeTruthy();
    shellListMode = "fail";

    await act(async () => {
      fireEvent.click(screen.getByTitle("Refresh"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Copy attach command for main" })).toBeTruthy();
    expect(screen.getByText("Failed to load shells")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Refresh"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("bench")).toBeTruthy();
    expect(screen.queryByText("Failed to load shells")).toBeNull();
  });

  it("refreshes the Shells sidebar while open so exited zellij sessions disappear", async () => {
    let shellList = [{ name: "main", status: "active" }];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessions: shellList }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);
    const shellListCallsBeforeWait = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") && init?.method !== "POST"
    )).length;

    await act(async () => {
      shellList = [];
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const shellListCallsAfterWait = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).endsWith("/api/terminal/sessions") && init?.method !== "POST"
    )).length;
    expect(shellListCallsAfterWait).toBeGreaterThan(shellListCallsBeforeWait);
    expect(screen.queryByRole("button", { name: "Copy attach command for main" })).toBeNull();
  });

  it("does not clobber a concurrent Shells refresh when delete rollback runs", async () => {
    let shellList = [{ name: "main", status: "active" }];
    let resolveDelete: ((value: { ok: boolean; status: number; json: () => Promise<object> }) => void) | undefined;
    const deletePromise = new Promise<{ ok: boolean; status: number; json: () => Promise<object> }>((resolve) => {
      resolveDelete = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions/main?force=1") && init?.method === "DELETE") {
        return deletePromise;
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessions: shellList }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Copy attach command for main" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete main/i }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Copy attach command for main" })).toBeNull();

    await act(async () => {
      shellList = [{ name: "bench", status: "active" }];
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("bench")).toBeTruthy();

    await act(async () => {
      resolveDelete?.({ ok: false, status: 503, json: async () => ({ ok: false }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("bench")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy attach command for main" })).toBeTruthy();
    expect(screen.getByText("Failed to remove shell")).toBeTruthy();
  });

  it("surfaces shell creation failures in the Shells sidebar", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/files/tree")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.includes("/api/terminal/sessions") && init?.method === "POST") {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false }) });
      }
      if (url.includes("/api/terminal/sessions")) {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [{ name: "main", status: "active" }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Shells" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New" }));
      await Promise.resolve();
    });

    expect(screen.getByText("Failed to create shell")).toBeTruthy();
  });
});
