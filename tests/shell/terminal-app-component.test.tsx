// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

  it("does not render workspace transport ids as managed shell sessions", async () => {
    render(<TerminalApp initialSessionId="matrix-sess_run_db0dded67faaca6b" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("matrix-sess_run_db0dded67faaca6b")).toBeNull();
    expect(screen.queryByRole("button", { name: /close matrix-sess_run_db0dded67faaca6b/i })).toBeNull();
  });

  it("uses its Paper chrome traffic lights for host window controls", async () => {
    const close = vi.fn();
    const minimize = vi.fn();
    const toggleFullscreen = vi.fn();
    render(<TerminalApp windowControls={{ close, minimize, toggleFullscreen }} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal window" }));
    fireEvent.click(screen.getByRole("button", { name: "Minimize Terminal window" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle Terminal fullscreen" }));

    expect(close).toHaveBeenCalledOnce();
    expect(minimize).toHaveBeenCalledOnce();
    expect(toggleFullscreen).toHaveBeenCalledOnce();
  });

  it("keeps the mobile terminal chrome clear of cwd badges that overlap zellij tabs", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("~/projects")).toBeNull();
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
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

  it("renders the redesigned desktop shell with sessions in the drawer instead of top tabs", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("tablist", { name: "Terminal tabs" })).toBeNull();
    expect(screen.getByText("matrixos")).toBeTruthy();
    expect(screen.getByPlaceholderText("Find a session...")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Background")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(screen.queryByText("Zellij")).toBeNull();
  });

  it("copies Matrix shell connect commands from session rows", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("matrix shell connect")).toBeNull();
    const row = screen.getByRole("button", { name: "Open matrix-main" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);
    const actions = screen.getByTestId("terminal-session-actions-main");
    expect(within(actions).getByText("matrix shell connect")).toBeTruthy();
    expect(within(actions).getByText("main")).toBeTruthy();
    expect(actions.style.gap).toBe("25px");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy connect command for matrix-main" }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("mos shell attach main");
  });

  it("renames sessions from the Paper pencil affordance", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [{ idx: 0, name: "main", focused: true }] },
            ],
          }),
        } as Response);
      }
      if (url.endsWith("/api/terminal/sessions/main") && init?.method === "PATCH") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            session: {
              name: "review-main",
              status: "active",
              placement: "active",
              attachCommand: "mos shell attach review-main",
              attachedClients: 1,
              tabs: [{ idx: 0, name: "main", focused: true }],
            },
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = screen.getByRole("button", { name: "Open matrix-main" }).closest(".group");
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename matrix-main" }));
      await Promise.resolve();
    });

    const input = screen.getByRole("textbox", { name: "Session name for matrix-main" });
    fireEvent.change(input, { target: { value: "review-main" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Open review-main" })).toBeTruthy();
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/main"),
        init: expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ name: "review-main" }),
        }),
      }),
    ]));
  });

  it("persists Paper active and background placement toggles through the gateway", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 4, unread: true, visualStatus: "running", attachCommand: "mos shell attach main", tabs: [] },
              { name: "docs", status: "active", placement: "background", latestSeq: 11, lastSeenSeq: 5, unread: true, visualStatus: "idle", attachCommand: "mos shell attach docs", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/") && url.endsWith("/ui-state")) {
        return Promise.resolve({ ok: true, json: async () => ({ session: {} }) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move matrix-main to background" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make docs active" }));
      await Promise.resolve();
    });

    const uiStateCalls = calls.filter((call) => call.url.includes("/ui-state"));
    expect(uiStateCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/main/ui-state"),
        init: expect.objectContaining({ method: "PATCH", body: JSON.stringify({ placement: "background" }) }),
      }),
      expect.objectContaining({
        url: expect.stringContaining("/api/terminal/sessions/docs/ui-state"),
        init: expect.objectContaining({ method: "PATCH", body: JSON.stringify({ placement: "active", lastSeenSeq: 11 }) }),
      }),
    ]));
    expect(uiStateCalls.filter((call) => call.url.includes("/api/terminal/sessions/docs/ui-state"))).toHaveLength(1);
  });

  it("keeps successful session updates when another optimistic UI patch rolls back", async () => {
    let resolveMarkSeen: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/terminal/layout") && init?.method === "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      if (url.includes("/api/terminal/layout")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/terminal/sessions") && init?.method !== "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [
              { name: "main", status: "active", placement: "active", latestSeq: 7, lastSeenSeq: 4, unread: true, visualStatus: "running", attachCommand: "mos shell attach main", tabs: [] },
            ],
          }),
        } as Response);
      }
      if (url.includes("/api/terminal/sessions/main/ui-state")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { placement?: string; lastSeenSeq?: number };
        if (body.lastSeenSeq === 7 && body.placement === undefined) {
          return new Promise<Response>((resolve) => {
            resolveMarkSeen = resolve;
          });
        }
        if (body.placement === "background") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              session: { name: "main", status: "active", placement: "background", latestSeq: 7, lastSeenSeq: 4, unread: true, visualStatus: "running", attachCommand: "mos shell attach main", tabs: [] },
            }),
          } as Response);
        }
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });

    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move matrix-main to background" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Make matrix-main active" })).toBeTruthy();
    expect(resolveMarkSeen).toBeDefined();

    await act(async () => {
      resolveMarkSeen?.({ ok: false, json: async () => ({}) } as Response);
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Make matrix-main active" })).toBeTruthy();
  });

  it("focuses active shell rows without creating duplicate attached tabs", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockClear();
    const paneRenderCount = paneGridSpy.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(paneGridSpy.mock.calls).toHaveLength(paneRenderCount);
    const layoutSaveCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/layout") && init?.method === "PUT"
    ));
    expect(layoutSaveCalls.length).toBeGreaterThan(0);
    const latestBody = layoutSaveCalls.at(-1)?.[1]?.body;
    expect(typeof latestBody).toBe("string");
    expect(JSON.parse(latestBody as string).tabs).toHaveLength(1);
  });

  it("renders a mobile sessions surface with compact foreground and background toggles", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("matrixos")).toBeTruthy();
    expect(screen.getByPlaceholderText("Find a session...")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move matrix-main to background" })).toBeTruthy();
    expect(screen.queryByText("Zellij")).toBeNull();
  });

  it("opens mobile terminal detail with back navigation and command composer", async () => {
    render(<TerminalApp mobile />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open matrix-main" }));
      await Promise.resolve();
    });

    expect(screen.queryByPlaceholderText("Find a session...")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to sessions" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Command composer" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
      await Promise.resolve();
    });

    expect(screen.getByPlaceholderText("Find a session...")).toBeTruthy();
  });

  it("opens zellij-backed shell sessions from the new-session control", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
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

  it("opens the left terminal panel on Shells first", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByLabelText("Search sessions")).toBeTruthy();
  });

  it("renders the Paper collapsed sessions rail in layout flow when hidden", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-drawer-collapse-icon").querySelector('path[d="m11 17-5-5 5-5"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));

    const rail = screen.getByTestId("terminal-collapsed-rail");
    expect(rail.style.width).toBe("76px");
    expect(rail.className).not.toContain("absolute");
    expect(screen.getByRole("button", { name: "Expand sessions drawer" })).toBeTruthy();
    expect(screen.getByTestId("terminal-drawer-expand-icon").querySelector('path[d="m6 17 5-5-5-5"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  });

  it("keeps collapsed rail sessions visible after hiding a filtered drawer", async () => {
    render(<TerminalApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value: "no-matches" } });
    });

    expect(screen.getByText("No sessions match")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide sessions drawer" }));
    });

    expect(screen.getByTestId("terminal-collapsed-rail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
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
        json: async () => ({ sessions: [{ name: "main", status: "active", placement: "active", attachCommand: "mos shell attach main", attachedClients: 1, tabs: [] }] }),
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
      fireEvent.click(screen.getByRole("button", { name: "Copy connect command for matrix-main" }));
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("mos shell attach main");
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
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
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
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
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

    expect(screen.getByLabelText("Search sessions")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Open matrix-main" })).toBeTruthy();
    expect(screen.getByText("bench")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open bench/i }));
    });
    expect(paneGridSpy.mock.lastCall?.[0]).toMatchObject({
      paneTree: { sessionId: "bench" },
    });

    await act(async () => {
      const newButton = screen.getByRole("button", { name: "New session" });
      fireEvent.click(newButton);
      fireEvent.click(newButton);
      await Promise.resolve();
    });
    const createCalls = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions") && init?.method === "POST"
    ));
    expect(createCalls).toHaveLength(1);

    await act(async () => {
      const deleteButton = screen.getByRole("button", { name: /close matrix-main/i });
      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
      await Promise.resolve();
    });
    const deleteCalls = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions/main?force=1") && init?.method === "DELETE"
    ));
    expect(deleteCalls).toHaveLength(1);
    expect(screen.queryByText("matrix-main")).toBeNull();
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
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Copy connect command for matrix-main" })).toBeTruthy();
    expect(screen.queryByText("bench")).toBeNull();

    await act(async () => {
      revealBench = true;
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
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
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Copy connect command for matrix-main" })).toBeTruthy();
    shellListMode = "fail";

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Copy connect command for matrix-main" })).toBeTruthy();
    expect(screen.getByText("Failed to load shells")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
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
    expect(screen.queryByRole("button", { name: "Copy connect command for matrix-main" })).toBeNull();
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
    expect(screen.getByRole("button", { name: "Copy connect command for matrix-main" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /close matrix-main/i }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Copy connect command for matrix-main" })).toBeNull();

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
    expect(screen.getByRole("button", { name: "Copy connect command for matrix-main" })).toBeTruthy();
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
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      await Promise.resolve();
    });

    expect(screen.getByText("Failed to create shell")).toBeTruthy();
  });
});
