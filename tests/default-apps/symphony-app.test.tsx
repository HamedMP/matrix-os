// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/symphony/src/App.js";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: { children: React.ReactNode; className?: string }) => <span className={className}>{children}</span>,
}));

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Symphony app", () => {
  let calls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("open", vi.fn());
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/symphony/status") {
        return json({
          running: false,
          installationId: "sym_user_123",
          credentialConfigured: false,
          pollIntervalMs: 30000,
          maxConcurrentAgents: 3,
          counts: { queued: 1, running: 1, needsAttention: 1, handoff: 1 },
          lastPollAt: null,
        });
      }
      if (url === "/api/symphony/config") {
        return json({
          installation: {
            projectSlug: "matrix-os",
            enabled: false,
            credentialConfigured: false,
            pollIntervalMs: 30000,
            maxConcurrentAgents: 3,
            defaultAgent: "codex",
            authorizedOperators: ["user_456"],
          },
          rule: {
            teamId: "team_1",
            teamKey: "MAT",
            requiredLabels: ["symphony"],
            activeStates: ["Todo"],
            terminalStates: ["Done"],
            assigneeIds: ["linear_user"],
          },
        });
      }
      if (url === "/api/symphony/runs") {
        return json({
          runs: [
            {
              id: "run_1",
              status: "running",
              ticketIdentifier: "MAT-1",
              ticketTitle: "Build Symphony",
              ticketUrl: "https://linear.app/acme/issue/MAT-1",
              agent: "codex",
              projectSlug: "matrix-os",
              worktreeId: "wt_abc123def456",
              sessionId: "sess_run_1",
              lastEvent: "Agent session started",
              updatedAt: "2026-05-13T00:00:00.000Z",
            },
            {
              id: "run_2",
              status: "blocked",
              ticketIdentifier: "MAT-2",
              ticketTitle: "Needs workflow",
              agent: "codex",
              projectSlug: "matrix-os",
              lastEvent: "Workflow missing",
              updatedAt: "2026-05-13T00:00:00.000Z",
            },
          ],
        });
      }
      if (url === "/api/symphony/credentials/linear" && init?.method === "POST") {
        return json({ credentialConfigured: true, accountLabel: "Linear" });
      }
      if (url === "/api/symphony/config" && init?.method === "POST") {
        return json({ ok: true });
      }
      if (url.startsWith("/api/symphony/tickets/preview")) {
        return json({ tickets: [{ externalId: "issue_1", identifier: "MAT-1", title: "Build Symphony", stateName: "Todo", labels: ["symphony"] }] });
      }
      if (url === "/api/symphony/start" && init?.method === "POST") {
        return json({ running: true, installationId: "sym_user_123" });
      }
      if (url === "/api/symphony/runs/run_1/actions" && init?.method === "POST") {
        return json({ run: { id: "run_1", status: "stopped" } });
      }
      return json({ ok: true });
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the dashboard groups as the default Symphony surface", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("Build Symphony")).toBeTruthy());

    expect(screen.getAllByText("Queue").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Needs Attention").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Done / Handoff").length).toBeGreaterThan(0);
    expect(screen.getByText("Linear credential")).toBeTruthy();
  });

  it("saves a server-side Linear secret and non-secret rule set", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Build Symphony")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Setup")[0]);
    fireEvent.change(screen.getByLabelText("Linear API secret"), { target: { value: "lin_api_secret" } });
    fireEvent.change(screen.getByLabelText("Linear team ID"), { target: { value: "team_1" } });
    fireEvent.click(screen.getByText("Save and Preview Tickets"));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/symphony/credentials/linear")).toBe(true));
    const configCall = calls.find((call) => call.url === "/api/symphony/config" && call.init?.method === "POST");
    expect(configCall).toBeTruthy();
    expect(String(configCall?.init?.body)).not.toContain("lin_api_secret");
    expect(JSON.parse(String(configCall?.init?.body))).toMatchObject({
      installation: { authorizedOperators: ["user_456"] },
    });
  });

  it("runs dashboard actions without shell commands or raw GraphQL", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Build Symphony")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Stop")[0]);

    await waitFor(() => expect(calls.some((call) => call.url === "/api/symphony/runs/run_1/actions")).toBe(true));
    const actionCall = calls.find((call) => call.url === "/api/symphony/runs/run_1/actions");
    expect(actionCall?.init?.body).toBe(JSON.stringify({ type: "stop" }));
    expect(calls.some((call) => call.url.includes("/api/integrations/call"))).toBe(false);
  });
});
