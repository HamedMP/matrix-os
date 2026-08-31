// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paneGridSpy = vi.fn();
const WORKSPACE_ID = "tws_00000000000000000000000000000001";
const TAB_ID = "tt_00000000000000000000000000000001";
const SECOND_TAB_ID = "tt_00000000000000000000000000000002";
const THIRD_TAB_ID = "tt_00000000000000000000000000000003";
const REF_KEY = `${WORKSPACE_ID}:${TAB_ID}`;

vi.mock("../../shell/src/components/terminal/PaneGrid.js", () => ({
  PaneGrid: (props: unknown) => {
    paneGridSpy(props);
    return <div data-testid="terminal-pane-grid" />;
  },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    name: "matrix-dark",
    mode: "dark",
    colors: { background: "#1C2019", foreground: "#F0EFE5", primary: "#9CB77A" },
    fonts: { mono: "JetBrains Mono, monospace", sans: "Inter, system-ui, sans-serif" },
    radius: "0.75rem",
  }),
  saveTheme: vi.fn(async () => undefined),
}));

const terminalSettings = {
  appThemeId: "matrix-dark",
  themeId: "system",
  fontSize: 13,
  fontFamily: "JetBrains Mono",
  ligatures: true,
  cursorStyle: "block",
  smoothScroll: true,
  cursorBlink: true,
  setAppThemeId: vi.fn(),
  setThemeId: vi.fn(),
  setFontSize: vi.fn(),
  setFontFamily: vi.fn(),
  setLigatures: vi.fn(),
  setCursorStyle: vi.fn(),
  setSmoothScroll: vi.fn(),
  setCursorBlink: vi.fn(),
};

vi.mock("@/stores/terminal-settings", () => {
  const useTerminalSettings = (selector: (value: typeof terminalSettings) => unknown) => selector(terminalSettings);
  useTerminalSettings.getState = () => terminalSettings;
  return {
    TERMINAL_FONT_FAMILIES: ["JetBrains Mono"],
    DEFAULT_TERMINAL_THEME_ID: "dark",
    DEFAULT_TERMINAL_APP_THEME_ID: "matrix-dark",
    useTerminalSettings,
  };
});
import { TerminalApp } from "../../shell/src/components/terminal/TerminalApp.js";
import { drainTerminalLaunchQueue, enqueueTerminalLaunch } from "../../shell/src/lib/terminal-launch.js";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function tab(id = TAB_ID, name = "Shell", cwd = "projects") {
  return {
    id,
    internalName: `mt_${id.slice(3)}`,
    zellijTabId: id === TAB_ID ? 1 : 2,
    zellijPaneId: id === TAB_ID ? 11 : 12,
    name,
    cwd,
    status: "running",
    revision: 1,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function workspace(tabs = [tab()], projectId?: string) {
  return {
    id: WORKSPACE_ID,
    scope: projectId ? "project" : "main",
    ...(projectId ? { projectId } : {}),
    internalName: "zw_00000000000000000000000000000001",
    canonicalSize: { cols: 120, rows: 40 },
    status: "running",
    revision: 1,
    tabs,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalApp workspace contract", () => {
  beforeEach(() => {
    paneGridSpy.mockReset();
    window.sessionStorage.clear();
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace()] });
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.includes("/api/terminal/layout")) return json(init?.method === "PUT" ? { ok: true } : {});
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      if (url.endsWith("/api/files/tree")) return json([]);
      return json({});
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens a canvas-provided TerminalRef without creating another tab", async () => {
    render(<TerminalApp initialSessionId={REF_KEY} />);
    await settle();

    const props = paneGridSpy.mock.lastCall?.[0] as { paneTree: { sessionId?: string } };
    expect(props.paneTree.sessionId).toBe(REF_KEY);
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/tabs") && init?.method === "POST")).toBe(false);
  });

  it("loads sidebar rows from workspace tabs", async () => {
    render(<TerminalApp initialSessionId={REF_KEY} />);
    await settle();

    expect(screen.getByTestId(`terminal-session-card-${REF_KEY}`)).toBeTruthy();
    expect(screen.getByText("Shell")).toBeTruthy();
  });

  it("keeps duplicate display names distinct through stable tab ids", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace([tab(), tab(SECOND_TAB_ID)])] });
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.includes("/api/terminal/layout")) return json({});
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      return json({});
    });
    render(<TerminalApp initialSessionId={REF_KEY} />);
    await settle();

    expect(screen.getByTestId(`terminal-session-card-${WORKSPACE_ID}:${TAB_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`terminal-session-card-${WORKSPACE_ID}:${SECOND_TAB_ID}`)).toBeTruthy();
  });

  it("renders 23 idle tabs without a client-side tab ceiling", async () => {
    const tabs = Array.from({ length: 23 }, (_, index) => tab(`tt_${(index + 1).toString(16).padStart(32, "0")}`, `Shell ${index + 1}`));
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace(tabs)] });
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.includes("/api/terminal/layout")) return json({});
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      return json({});
    });
    render(<TerminalApp initialSessionId={`${WORKSPACE_ID}:${tabs[0]!.id}`} />);
    await settle();

    expect(screen.getAllByTestId(/terminal-session-card-/)).toHaveLength(23);
  });

  it("uses soft terminal sizing on mobile", async () => {
    render(<TerminalApp initialSessionId={REF_KEY} mobile />);
    await settle();
    expect((paneGridSpy.mock.lastCall?.[0] as { allowRemoteResize?: boolean }).allowRemoteResize).toBe(false);
  });

  it("allows desktop panes to participate in canonical sizing", async () => {
    render(<TerminalApp initialSessionId={REF_KEY} />);
    await settle();
    expect((paneGridSpy.mock.lastCall?.[0] as { allowRemoteResize?: boolean }).allowRemoteResize).toBe(true);
  });

  it("creates a tab under the ensured workspace", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace()] });
      if (url.endsWith("/api/terminal/workspaces/ensure")) return json({ workspace: workspace() });
      if (url.endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`) && init?.method === "POST") return json({ tab: tab(SECOND_TAB_ID, "Terminal") }, 201);
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.includes("/api/terminal/layout")) return json({});
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      if (url.endsWith("/api/files/tree")) return json([]);
      return json({});
    });
    render(<TerminalApp initialSessionId={REF_KEY} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "New shell session" }));
    await settle();

    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      expect.stringContaining(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`),
      expect.objectContaining({ method: "POST" }),
    ]);
  });

  it("creates queued runtime launches as canonical workspace tabs", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace()] });
      if (url.endsWith("/api/terminal/workspaces/ensure")) return json({ workspace: workspace() });
      if (url.endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`) && init?.method === "POST") {
        return json({ tab: tab(SECOND_TAB_ID, "Claude login") }, 201);
      }
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.includes("/api/terminal/layout")) return json({});
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      if (url.endsWith("/api/files/tree")) return json([]);
      return json({});
    });
    render(<TerminalApp initialSessionId={REF_KEY} launchTargetId="runtime-settings" />);
    await settle();

    await act(async () => {
      enqueueTerminalLaunch("claude-login", "runtime-settings");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      expect.stringContaining(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Claude login", cwd: "projects", command: ["sh", "-lc", "claude"] }),
      }),
    ]);
    const props = paneGridSpy.mock.lastCall?.[0] as { paneTree: { sessionId?: string } };
    expect(props.paneTree.sessionId).toBe(`${WORKSPACE_ID}:${SECOND_TAB_ID}`);
  });

  it("keeps a queued runtime launch when workspace creation fails", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace()] });
      if (url.endsWith("/api/terminal/workspaces/ensure")) return json({}, 503);
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.includes("/api/terminal/layout")) return json({});
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      if (url.endsWith("/api/files/tree")) return json([]);
      return json({});
    });
    render(<TerminalApp initialSessionId={REF_KEY} launchTargetId="runtime-settings" />);
    await settle();

    await act(async () => {
      enqueueTerminalLaunch("claude-login", "runtime-settings");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(drainTerminalLaunchQueue("runtime-settings").map((launch) => launch.action)).toEqual([
      "claude-login",
    ]);
  });

  it("requeues a launch and deletes its tab when creation completes after unmount", async () => {
    let resolveTabResponse: ((response: Response) => void) | undefined;
    const tabResponse = new Promise<Response>((resolve) => {
      resolveTabResponse = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace()] });
      if (url.endsWith("/api/terminal/workspaces/ensure")) return json({ workspace: workspace() });
      if (url.endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`) && init?.method === "POST") {
        return tabResponse;
      }
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.includes("/api/terminal/layout")) return json({});
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      if (url.endsWith("/api/files/tree")) return json([]);
      return json({});
    });
    const view = render(<TerminalApp initialSessionId={REF_KEY} launchTargetId="runtime-settings" />);
    await settle();

    await act(async () => {
      enqueueTerminalLaunch("claude-login", "runtime-settings");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`))).toBe(true);
    view.unmount();

    await act(async () => {
      resolveTabResponse?.(json({ tab: tab(SECOND_TAB_ID, "Claude login") }, 201));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(drainTerminalLaunchQueue("runtime-settings").map((launch) => launch.action)).toEqual([
      "claude-login",
    ]);
    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      expect.stringContaining(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${SECOND_TAB_ID}`),
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    ]);
  });

  it("does not duplicate a late-created launch when tab cleanup fails", async () => {
    let resolveTabResponse: ((response: Response) => void) | undefined;
    const tabResponse = new Promise<Response>((resolve) => {
      resolveTabResponse = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace()] });
      if (url.endsWith("/api/terminal/workspaces/ensure")) return json({ workspace: workspace() });
      if (url.endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`) && init?.method === "POST") {
        return tabResponse;
      }
      if (url.endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${SECOND_TAB_ID}`) && init?.method === "DELETE") {
        return json({}, 503);
      }
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.includes("/api/terminal/layout")) return json({});
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      if (url.endsWith("/api/files/tree")) return json([]);
      return json({});
    });
    const view = render(<TerminalApp initialSessionId={REF_KEY} launchTargetId="runtime-settings" />);
    await settle();

    await act(async () => {
      enqueueTerminalLaunch("claude-login", "runtime-settings");
      await Promise.resolve();
      await Promise.resolve();
    });
    view.unmount();

    await act(async () => {
      resolveTabResponse?.(json({ tab: tab(SECOND_TAB_ID, "Claude login") }, 201));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(drainTerminalLaunchQueue("runtime-settings")).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => (
      String(input).endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`)
      && init?.method === "POST"
    ))).toHaveLength(1);
  });

  it("never calls a retired terminal session route", async () => {
    render(<TerminalApp initialSessionId={REF_KEY} />);
    await settle();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/api/terminal/sessions"))).toBe(false);
  });

  it("loads and revision-saves only its ID-scoped Terminal window layout", async () => {
    const layoutId = "term-layout_0123456789abcdef0123456789abcdef";
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace([tab(), tab(SECOND_TAB_ID)])] });
      if (url.includes(`/api/terminal/window-layouts/${layoutId}`) && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { layout: unknown };
        return json({ layoutId, revision: 5, layout: body.layout });
      }
      if (url.includes(`/api/terminal/window-layouts/${layoutId}`)) {
        return json({
          layoutId,
          revision: 4,
          layout: {
            activeTabId: "saved-tab",
            sidebarOpen: true,
            tabs: [{
              id: "saved-tab",
              label: "Shell",
              paneTree: { type: "pane", id: "saved-pane", cwd: "projects", sessionId: REF_KEY },
            }],
          },
        });
      }
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      if (url.endsWith("/api/files/tree")) return json([]);
      return json({});
    });

    render(<TerminalApp layoutId={layoutId} />);
    await settle();
    const paneProps = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };
    act(() => paneProps.onSessionAttached(paneProps.paneTree.id, `${WORKSPACE_ID}:${SECOND_TAB_ID}`));
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
    });

    const putCall = vi.mocked(fetch).mock.calls.find(([input, init]) => (
      String(input).includes(`/api/terminal/window-layouts/${layoutId}`) && init?.method === "PUT"
    ));
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      baseRevision: 4,
      layout: {
        activeTabId: "saved-tab",
        tabs: [{ paneTree: { sessionId: `${WORKSPACE_ID}:${SECOND_TAB_ID}` } }],
      },
    });
  });

  it("rebases local workspace refs onto a newer durable layout revision", async () => {
    const layoutId = "term-layout_0123456789abcdef0123456789abcdef";
    let layoutReads = 0;
    let layoutWrites = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace([tab(), tab(SECOND_TAB_ID)])] });
      if (url.includes(`/api/terminal/window-layouts/${layoutId}`) && init?.method === "PUT") {
        layoutWrites += 1;
        if (layoutWrites === 1) return json({ error: "Layout changed elsewhere" }, 409);
        const body = JSON.parse(String(init.body)) as { layout: unknown };
        return json({ layoutId, revision: 6, layout: body.layout });
      }
      if (url.includes(`/api/terminal/window-layouts/${layoutId}`)) {
        layoutReads += 1;
        return json({
          layoutId,
          revision: layoutReads === 1 ? 4 : 5,
          layout: {
            activeTabId: "saved-tab",
            sidebarOpen: layoutReads === 1,
            tabs: [{
              id: "saved-tab",
              label: "Shell",
              paneTree: { type: "pane", id: "saved-pane", cwd: "projects", sessionId: REF_KEY },
            }],
          },
        });
      }
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      if (url.endsWith("/api/files/tree")) return json([]);
      return json({});
    });

    render(<TerminalApp layoutId={layoutId} />);
    await settle();
    const paneProps = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { id: string };
      onSessionAttached: (paneId: string, sessionId: string) => void;
    };
    act(() => paneProps.onSessionAttached(paneProps.paneTree.id, `${WORKSPACE_ID}:${SECOND_TAB_ID}`));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const putCalls = vi.mocked(fetch).mock.calls.filter(([input, init]) => (
      String(input).includes(`/api/terminal/window-layouts/${layoutId}`) && init?.method === "PUT"
    ));
    expect(putCalls).toHaveLength(2);
    expect(JSON.parse(String(putCalls[1]?.[1]?.body))).toMatchObject({
      baseRevision: 5,
      layout: {
        sidebarOpen: false,
        tabs: [{ paneTree: { sessionId: `${WORKSPACE_ID}:${SECOND_TAB_ID}` } }],
      },
    });
  });

  it("does not read or save durable layouts for an ephemeral setup terminal", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces/ensure")) return json({ workspace: workspace() });
      if (url.endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`) && init?.method === "POST") {
        return json({ tab: tab(SECOND_TAB_ID, "Setup") }, 201);
      }
      return json({});
    });
    const view = render(<TerminalApp persistence="ephemeral" initialCommand="codex" />);
    await settle();
    view.unmount();
    await settle();

    expect(vi.mocked(fetch).mock.calls.some(([input]) => (
      String(input).includes("/api/terminal/layout")
      || String(input).includes("/api/terminal/window-layouts")
      || String(input).includes("/api/terminal/sessions")
    ))).toBe(false);
    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      expect.stringContaining(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${SECOND_TAB_ID}`),
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    ]);
  });

  it("recovers a missing durable tab with a replacement workspace tab", async () => {
    const layoutId = "term-layout_0123456789abcdef0123456789abcdef";
    const missingRef = `${WORKSPACE_ID}:${SECOND_TAB_ID}`;
    const replacementRef = `${WORKSPACE_ID}:${THIRD_TAB_ID}`;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/terminal/workspaces")) return json({ workspaces: [workspace()] });
      if (url.endsWith("/api/terminal/workspaces/ensure")) return json({ workspace: workspace() });
      if (url.endsWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`) && init?.method === "POST") {
        return json({ tab: tab(THIRD_TAB_ID, "Recovered terminal") }, 201);
      }
      if (url.includes(`/api/terminal/window-layouts/${layoutId}`)) {
        return json({
          layoutId,
          revision: 4,
          layout: {
            activeTabId: "saved-tab",
            sidebarOpen: true,
            tabs: [{
              id: "saved-tab",
              label: "Shell",
              paneTree: { type: "pane", id: "saved-pane", cwd: "projects", sessionId: missingRef },
            }],
          },
        });
      }
      if (url.endsWith("/api/terminal/preferences")) return json({ preferences: {} });
      if (url.endsWith("/api/agents")) return json({ agents: [] });
      if (url.endsWith("/api/files/tree")) return json([]);
      return json({});
    });

    render(<TerminalApp layoutId={layoutId} />);
    await settle();
    const props = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { sessionId?: string };
      unavailableSessionIds?: string[];
      onRecoverSession?: (sessionId: string, cwd: string) => Promise<boolean>;
    };
    expect(props.unavailableSessionIds).toEqual([missingRef]);

    await act(async () => {
      await expect(props.onRecoverSession?.(missingRef, "projects")).resolves.toBe(true);
    });

    expect(vi.mocked(fetch).mock.calls).toContainEqual([
      expect.stringContaining(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Recovered terminal", cwd: "projects" }),
      }),
    ]);
    const recoveredProps = paneGridSpy.mock.lastCall?.[0] as {
      paneTree: { sessionId?: string };
      unavailableSessionIds?: string[];
    };
    expect(recoveredProps.paneTree.sessionId).toBe(replacementRef);
    expect(recoveredProps.unavailableSessionIds).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/api/terminal/sessions"))).toBe(false);
  });
});
