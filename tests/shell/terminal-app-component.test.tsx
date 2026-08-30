// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paneGridSpy = vi.fn();
const WORKSPACE_ID = "tws_00000000000000000000000000000001";
const TAB_ID = "tt_00000000000000000000000000000001";
const SECOND_TAB_ID = "tt_00000000000000000000000000000002";
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

  it("never calls a retired terminal session route", async () => {
    render(<TerminalApp initialSessionId={REF_KEY} />);
    await settle();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/api/terminal/sessions"))).toBe(false);
  });
});
