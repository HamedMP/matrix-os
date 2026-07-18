// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode } from "../../shell/src/stores/terminal-store.js";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "../../shell/src/components/terminal/terminal-input-event.js";

vi.mock("../../shell/src/components/terminal/PaneGrid.js", () => ({
  PaneGrid: ({ paneTree }: { paneTree: PaneNode }) => {
    const paneId = paneTree.type === "pane" ? paneTree.id : "pane-1";
    return <div data-testid="pane-grid" data-pane-id={paneId} />;
  },
}));

vi.mock("../../shell/src/components/terminal/TerminalKeyBar.js", () => ({
  TerminalKeyBar: () => <div data-testid="terminal-key-bar" />,
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    mode: "dark",
    colors: { background: "#101010", foreground: "#eeeeee", primary: "#d88944" },
    fonts: {},
  }),
}));

vi.mock("@/stores/terminal-settings", () => {
  const state = {
    appThemeId: "matrix-dark",
    themeId: "system",
    fontSize: 13,
    fontFamily: "JetBrains Mono",
    ligatures: true,
    cursorStyle: "block",
    smoothScroll: true,
    cursorBlink: true,
    setAppThemeId: () => {},
    setThemeId: () => {},
    setFontSize: () => {},
    setFontFamily: () => {},
    setLigatures: () => {},
    setCursorStyle: () => {},
    setSmoothScroll: () => {},
    setCursorBlink: () => {},
  };

  return {
    TERMINAL_FONT_FAMILIES: ["MesloLGS NF", "Berkeley Mono", "JetBrains Mono", "Fira Code"],
    DEFAULT_TERMINAL_THEME_ID: "dark",
    DEFAULT_TERMINAL_APP_THEME_ID: "matrix-dark",
    useTerminalSettings: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

import { TerminalApp } from "../../shell/src/components/terminal/TerminalApp.js";

describe("TerminalApp mobile actions", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe = vi.fn();
      disconnect = vi.fn();
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ tabs: [] }) });
      }
      if (url.endsWith("/api/terminal/sessions")) {
        return Promise.resolve({ ok: true, status: 201, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));
  });

  it("shows the simplified mobile terminal actions above the accessory keybar", async () => {
    render(<TerminalApp mobile />);

    await waitFor(() => expect(screen.getByTestId("terminal-mobile-actions")).toBeTruthy());

    expect(screen.getByText("+ Session")).toBeTruthy();
    for (const name of ["New session", "Paste", "Search"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    for (const name of ["Shell", "Pane", "Tab", "Cmd"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("opens the shared new-session menu and creates a canonical shell session from mobile", async () => {
    const fetchMock = vi.mocked(fetch);

    render(<TerminalApp mobile />);

    const newSession = await screen.findByRole("button", { name: "New session" });
    expect(newSession.getAttribute("aria-haspopup")).toBe("menu");
    expect(newSession.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(newSession);

    const menu = await screen.findByRole("menu", { name: "New session menu" });
    expect(newSession.getAttribute("aria-expanded")).toBe("true");
    expect(menu.textContent).toContain("NEW TAB");
    expect(screen.getByRole("menuitem", { name: /^Shell(?:\s+⌘T)?$/i })).toBeTruthy();

    fireEvent.click(newSession);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "New session menu" })).toBeNull());
    expect(newSession.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(newSession);
    await screen.findByRole("menu", { name: "New session menu" });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Shell(?:\s+⌘T)?$/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => (
        String(input).endsWith("/api/terminal/sessions") &&
        init?.method === "POST" &&
        typeof init.body === "string"
      ))).toBe(true);
    });

    expect(screen.queryByText("Mobile Shell")).toBeNull();
  });

  it("dispatches paste and search actions to the focused pane", async () => {
    const events: TerminalInputEventDetail[] = [];
    const listener = ((event: CustomEvent<TerminalInputEventDetail>) => {
      events.push(event.detail);
    }) as EventListener;
    window.addEventListener(TERMINAL_INPUT_EVENT, listener);

    render(<TerminalApp mobile />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Paste" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(events).toEqual([
      expect.objectContaining({ action: "paste" }),
      expect.objectContaining({ action: "search" }),
    ]);
    window.removeEventListener(TERMINAL_INPUT_EVENT, listener);
  });

  it("loads mobile new-session agent status once under React Strict Mode", async () => {
    const fetchMock = vi.mocked(fetch);

    render(
      <React.StrictMode>
        <TerminalApp mobile />
      </React.StrictMode>,
    );

    const newSession = await screen.findByRole("button", { name: "New session" });
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input]) => (
        String(input).endsWith("/api/agents")
      )).length).toBeGreaterThanOrEqual(2);
    });
    fetchMock.mockClear();

    fireEvent.click(newSession);
    await screen.findByRole("menu", { name: "New session menu" });

    await waitFor(() => {
      const agentStatusCalls = fetchMock.mock.calls.filter(([input]) => (
        String(input).endsWith("/api/agents")
      ));
      expect(agentStatusCalls).toHaveLength(1);
    });
  });

  it("shows checking on mobile and launches directly while the status request is pending", async () => {
    const pendingAgentStatus = new Promise<Response>(() => {});
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/agents")) return pendingAgentStatus;
      if (url.endsWith("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ tabs: [] }) });
      }
      if (url.endsWith("/api/terminal/sessions")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { name?: string } : {};
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ name: body.name }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TerminalApp mobile />);
    fireEvent.click(await screen.findByRole("button", { name: "New session" }));

    const menu = await screen.findByRole("menu", { name: "New session menu" });
    expect(within(menu).getAllByText("Checking…")).toHaveLength(4);
    expect(within(menu).queryByText("Install")).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Claude Code.*Checking/ }));

    await waitFor(() => {
      const payloads = fetchMock.mock.calls
        .filter(([input, init]) => String(input).endsWith("/api/terminal/sessions") && init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as { cmd?: string });
      expect(payloads).toEqual(expect.arrayContaining([expect.objectContaining({ cmd: "claude" })]));
      expect(payloads.some((payload) => payload.cmd?.includes("npm install"))).toBe(false);
    });
  });

  it("shows Install on mobile only for an explicitly missing executable", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/agents")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude", installState: "missing", installed: false },
              { id: "codex", installState: "unknown", installed: null },
              { id: "opencode", installState: "installed", installed: true },
              { id: "pi", installState: "unknown", installed: null },
            ],
          }),
        });
      }
      if (url.endsWith("/api/terminal/layout") && init?.method !== "PUT") {
        return Promise.resolve({ ok: true, json: async () => ({ tabs: [] }) });
      }
      return Promise.resolve({ ok: true, status: 201, json: async () => ({}) });
    }));

    render(<TerminalApp mobile />);
    fireEvent.click(await screen.findByRole("button", { name: "New session" }));

    const menu = await screen.findByRole("menu", { name: "New session menu" });
    await waitFor(() => {
      expect(within(menu).getByRole("menuitem", { name: /Claude Code.*Install/ })).toBeTruthy();
    });
    expect(within(menu).getAllByText("Install")).toHaveLength(1);
    expect(within(menu).getByRole("menuitem", { name: /^OpenCode$/ })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /Codex.*Install/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Pi.*Install/ })).toBeNull();
  });

  it("keeps mobile command input keyboard-safe and uses green primary actions", async () => {
    render(<TerminalApp mobile />);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Command composer" })).toBeTruthy());

    const newSession = screen.getByRole("button", { name: "New session" });
    const composer = screen.getByRole("textbox", { name: "Command composer" });
    const send = screen.getByRole("button", { name: "Send command" });

    expect(newSession.style.background).toBe("var(--terminal-mobile-primary-bg)");
    expect(send.style.background).toBe("var(--terminal-mobile-primary-bg)");
    expect(composer.style.fontSize).toBe("16px");
    expect(composer.getAttribute("autocomplete")).toBe("off");
    expect(composer.getAttribute("enterkeyhint")).toBe("send");
  });
});
