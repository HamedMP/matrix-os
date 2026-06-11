// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/symphony/src/App.js";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: { children: React.ReactNode; className?: string }) => <span className={className}>{children}</span>,
}));

function symphonyState() {
  return {
    service: { status: "ready", credentialStatus: "connected", generatedAt: "2026-05-25T00:00:00Z" },
    groups: {
      queue: [{ issueIdentifier: "MAT-31", status: "queued", latestEvent: "Queued" }],
      running: [{ issueIdentifier: "MAT-32", status: "running", sessionId: "thread-1-turn-2", turnCount: 2, latestEvent: "session_started" }],
      needsAttention: [{ issueIdentifier: "MAT-33", status: "needs_attention", attempt: 2, latestEvent: "retrying" }],
      done: [{ issueIdentifier: "MAT-34", status: "done", latestEvent: "handoff" }],
    },
  };
}

function gatewayFetchMock() {
  return vi.mocked(window.MatrixOS!.gatewayFetch!);
}

describe("Symphony app", () => {
  let calls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("open", vi.fn());
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Symphony app must use the MatrixOS bridge");
    }));
    window.MatrixOS = {
      gatewayFetch: vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/api/symphony/state") {
          return symphonyState();
        }
        if (url === "/api/symphony/issues/MAT-32") {
          return {
            issueIdentifier: "MAT-32",
            issueId: "issue_32",
            status: "running",
            sessionId: "thread-1-turn-2",
            turnCount: 2,
            latestEvent: "session_started",
            latestMessage: "Agent session started",
            workspacePath: "/home/matrix/home/projects/matrix-os/symphony-workspaces/MAT-32",
            workpadUrl: "https://linear.app/acme/issue/MAT-32#comment",
            logs: { codexSessionLogs: ["session started", "tool call"] },
            recentEvents: [{ event: "session_started", message: "Agent session started" }],
            retry: null,
            allowedActions: ["refresh", "open_workspace", "stop"],
          };
        }
        if (url === "/api/symphony/issues/MAT-33") {
          return {
            issueIdentifier: "MAT-33",
            issueId: "issue_33",
            status: "needs_attention",
            sessionId: null,
            turnCount: 0,
            latestEvent: "retrying",
            latestMessage: "Retry detail",
            workspacePath: "/home/matrix/home/projects/matrix-os/symphony-workspaces/MAT-33",
            workpadUrl: null,
            logs: { codexSessionLogs: ["retry detail"] },
            recentEvents: [{ event: "retrying", message: "Retry detail" }],
            retry: { attempt: 2, dueAt: null },
            allowedActions: ["refresh", "open_workspace"],
          };
        }
        if (url === "/api/symphony/refresh") {
          return { requested: true, requestedAt: "2026-05-25T00:00:01Z" };
        }
        if (url === "/api/symphony/runs/MAT-32/stop") {
          return { stopped: true };
        }
        if (url === "/api/symphony/service") {
          return { service: { available: true, running: true, status: "running", canStart: false, canStop: true, credentialConfigured: true } };
        }
        if (url === "/api/symphony/service/start" || url === "/api/symphony/service/stop") {
          return { service: { available: true, running: url.endsWith("/start"), status: url.endsWith("/start") ? "running" : "stopped", canStart: !url.endsWith("/start"), canStop: url.endsWith("/start"), credentialConfigured: true } };
        }
        return { ok: true };
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports its stylesheet so the Vite bundle ships CSS", () => {
    const entrypoint = readFileSync("home/apps/symphony/src/main.tsx", "utf8");

    expect(entrypoint).toMatch(/import ['"]\.\/index\.css['"]/);
  });

  it("shows Elixir state groups and active Codex app-server details", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getAllByText("MAT-32").length).toBeGreaterThan(0));

    expect(screen.getAllByText("Queue").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Needs Attention").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Done / Handoff").length).toBeGreaterThan(0);
    expect(screen.getAllByText("thread-1-turn-2").length).toBeGreaterThan(0);
    expect(screen.getByText("Linear: connected")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getAllByText("session_started").length).toBeGreaterThan(0);
    expect(screen.getByText("/home/matrix/home/projects/matrix-os/symphony-workspaces/MAT-32")).toBeTruthy();
    expect(screen.getByText("session started")).toBeTruthy();
    expect(screen.getByText("Workpad")).toBeTruthy();
    expect(screen.queryByText("Open Workpad")).toBeNull();
  });

  it("does not reload the full state when selecting an issue", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("MAT-32").length).toBeGreaterThan(0));
    const stateCallsBeforeClick = calls.filter((call) => call.url === "/api/symphony/state").length;

    fireEvent.click(screen.getByText("MAT-33"));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/symphony/issues/MAT-33")).toBe(true));
    await waitFor(() => expect(screen.getAllByText("retry detail").length).toBeGreaterThan(0));
    expect(calls.filter((call) => call.url === "/api/symphony/state").length).toBe(stateCallsBeforeClick);
  });

  it("disables issue selection while refresh state is in flight", async () => {
    let stateCalls = 0;
    let resolveRefreshState: ((state: ReturnType<typeof symphonyState>) => void) | null = null;
    gatewayFetchMock().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/symphony/state") {
        stateCalls += 1;
        if (stateCalls === 1) return symphonyState();
        return await new Promise<ReturnType<typeof symphonyState>>((resolve) => {
          resolveRefreshState = resolve;
        });
      }
      if (url === "/api/symphony/refresh") return { requested: true };
      if (url === "/api/symphony/issues/MAT-32") {
        return {
          issueIdentifier: "MAT-32",
          issueId: "issue_32",
          status: "running",
          sessionId: "thread-1-turn-2",
          turnCount: 2,
          latestEvent: "session_started",
          latestMessage: "Agent session started",
          workspacePath: "/home/matrix/home/projects/matrix-os/symphony-workspaces/MAT-32",
          workpadUrl: null,
          logs: { codexSessionLogs: ["session started"] },
          recentEvents: [],
          retry: null,
          allowedActions: ["refresh", "open_workspace", "stop"],
        };
      }
      if (url === "/api/symphony/issues/MAT-33") {
        return {
          issueIdentifier: "MAT-33",
          issueId: "issue_33",
          status: "needs_attention",
          sessionId: null,
          turnCount: 0,
          latestEvent: "retrying",
          latestMessage: "Retry detail",
          workspacePath: "/home/matrix/home/projects/matrix-os/symphony-workspaces/MAT-33",
          workpadUrl: null,
          logs: { codexSessionLogs: ["retry detail"] },
          recentEvents: [],
          retry: { attempt: 2, dueAt: null },
          allowedActions: ["refresh", "open_workspace"],
        };
      }
      return { ok: true };
    });

    render(<App />);
    await waitFor(() => expect(screen.getAllByText("MAT-32").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText("session started").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/symphony/refresh")).toBe(true));
    const attentionButton = screen.getByText("MAT-33").closest("button");
    expect(attentionButton?.disabled).toBe(true);

    fireEvent.click(screen.getByText("MAT-33"));
    expect(calls.some((call) => call.url === "/api/symphony/issues/MAT-33")).toBe(false);
    resolveRefreshState?.(symphonyState());

    await waitFor(() => expect(screen.getAllByText("session started").length).toBeGreaterThan(0));
    expect(calls.some((call) => call.url === "/api/symphony/issues/MAT-33")).toBe(false);
  });

  it("refreshes and stops runs through the Elixir proxy endpoints", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("MAT-32").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/symphony/refresh" && call.init?.method === "POST")).toBe(true));

    fireEvent.click(screen.getByText("Stop Run"));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/symphony/runs/MAT-32/stop" && call.init?.method === "POST")).toBe(true));
    expect(calls.every((call) => !("signal" in (call.init ?? {})))).toBe(true);
  });

  it("lets the user start Symphony when the service is stopped", async () => {
    gatewayFetchMock().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/symphony/state") throw new Error("request_failed");
      if (url === "/api/symphony/service") {
        return { service: { available: true, running: false, status: "stopped", canStart: true, canStop: false, credentialConfigured: true } };
      }
      if (url === "/api/symphony/service/start") {
        return { service: { available: true, running: true, status: "running", canStart: false, canStop: true, credentialConfigured: true } };
      }
      return { ok: true };
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Service: stopped")).toBeTruthy());
    expect(screen.getByText("Symphony is unavailable.")).toBeTruthy();

    fireEvent.click(screen.getByText("Start"));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/symphony/service/start" && call.init?.method === "POST")).toBe(true));
  });

  it("keeps rendered state when the active issue detail endpoint fails", async () => {
    gatewayFetchMock().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/symphony/state") return symphonyState();
      if (url === "/api/symphony/issues/MAT-32") throw new Error("request_failed");
      return { ok: true };
    });

    render(<App />);

    await waitFor(() => expect(screen.getAllByText("Queue").length).toBeGreaterThan(0));
    expect(screen.queryByText("Symphony is unavailable.")).toBeNull();
    expect(screen.getByText("Issue detail could not be loaded.")).toBeTruthy();
  });

  it("clears initial loading once state is ready before issue detail resolves", async () => {
    let resolveDetail: (detail: Record<string, unknown>) => void = () => {};
    const detailResponse = new Promise<Record<string, unknown>>((resolve) => {
      resolveDetail = resolve;
    });

    gatewayFetchMock().mockImplementation(async (url: string) => {
      if (url === "/api/symphony/state") {
        return {
          service: { status: "ready", credentialStatus: "setup_required", generatedAt: "2026-05-25T00:00:00Z" },
          groups: {
            queue: [],
            running: [{ issueIdentifier: "MAT-32", status: "running" }],
            needsAttention: [],
            done: [],
          },
        };
      }
      if (url === "/api/symphony/issues/MAT-32") {
        return detailResponse;
      }
      return { ok: true };
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Connect Linear in Matrix Integrations to let Symphony poll assigned work.")).toBeTruthy();
    });
    expect(screen.queryByText("Loading Symphony state...")).toBeNull();

    await act(async () => {
      resolveDetail({
        issueIdentifier: "MAT-32",
        status: "running",
        allowedActions: ["refresh"],
        logs: { codexSessionLogs: [] },
        recentEvents: [],
      });
      await Promise.resolve();
    });
  });

  it("keeps long session and workspace text visible for mobile-friendly layouts", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("/home/matrix/home/projects/matrix-os/symphony-workspaces/MAT-32")).toBeTruthy());

    const appSource = readFileSync("home/apps/symphony/src/App.tsx", "utf8");
    expect(appSource).toContain("break-words");
    expect(appSource).toContain("minmax(0,1fr)");
    expect(appSource).toContain('const RUN_GROUPS: RunGroup[] = ["queue", "running", "needsAttention", "done"]');
    expect(appSource).toContain("matrix_bridge_unavailable");
    expect(appSource).toContain('"/api/symphony/service/start"');
    expect(appSource).toContain('"/api/symphony/service/stop"');
    expect(appSource).toContain("withTimeoutSignal(controller.signal, 10_000)");
    expect(appSource).toContain("AbortSignal.any([signal, timeoutSignal])");
    expect(appSource).toContain("window.MatrixOS.gatewayFetch");
    expect(appSource).not.toContain("await fetch(url");
    expect(appSource).toContain("if (controller.signal.aborted) return;");
    expect(appSource).not.toContain("controller.signal.aborted || isAbortError(err)");
    expect(appSource).toContain('setError("Issue detail could not be loaded.")');
    expect(appSource).toContain("detailAbortRef.current?.abort()");
    expect(appSource).toContain("selectedIssueRef.current");
    expect(appSource).toContain("chooseActiveIssue(next, selectedIssueRef.current, preferredIssue)");
    expect(appSource).toContain("const thisRequestId = detailRequestRef.current");
    expect(appSource).toContain("if (detailRequestRef.current === thisRequestId) setBusy(null);");
    expect(appSource).toContain("detailRequestRef.current === requestId");
    expect(appSource).toContain("}).slice(0, 100)");
    expect(appSource).toContain("disabled={Boolean(busy)}");
    expect(appSource).toContain("disabled:opacity-50");
    expect(appSource).toContain("run.issueIdentifier ?? run.issueId ?? run.sessionId ?? String(index)");
    expect(appSource).not.toContain("}, [selectedIssue]);");
    expect(appSource).not.toContain("Object.keys(state.groups)");
    expect(appSource).not.toContain('}, "*")');
    expect(appSource).toContain("window.location.origin");
  });
});
