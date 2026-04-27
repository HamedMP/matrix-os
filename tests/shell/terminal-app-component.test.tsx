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
  useTheme: () => ({ mode: "dark", colors: {}, fonts: {} }),
}));

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

  it("destroys a just-attached session when the tab closes before layout state catches up", async () => {
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
      props.onSessionAttached(props.paneTree.id, "session-pending-close");
    });

    fireEvent.click(screen.getByTitle("Close tab"));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const deleteCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes("/api/terminal/sessions/session-pending-close") && init?.method === "DELETE"
    ));

    expect(deleteCalls.length).toBe(1);
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
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("sess_abc123")).toBeTruthy();
    expect(screen.getByText("running health")).toBeTruthy();
    expect(screen.getByText("zellij attach matrix-sess_abc123")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search sessions and transcripts"), { target: { value: "task_abc123" } });
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
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/terminal/sessions"), expect.objectContaining({ method: "GET" }));
  });
});
