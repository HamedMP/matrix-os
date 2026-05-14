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
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Symphony desktop ticket assignment", () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("EventSource", class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/symphony/status") return json({ running: true, installationId: "sym_user_123", credentialConfigured: true, pollIntervalMs: 30000, maxConcurrentAgents: 3, counts: { queued: 0, running: 0, needsAttention: 0, handoff: 0 }, lastPollAt: null });
      if (url === "/api/symphony/config") return json({ installation: { projectSlug: "repo", enabled: true, credentialConfigured: true, pollIntervalMs: 30000, maxConcurrentAgents: 3, defaultAgent: "codex", authorizedOperators: [] }, rule: { teamId: "team_1", teamKey: "MAT", requiredLabels: [], activeStates: ["Todo"], terminalStates: ["Done"], assigneeIds: [] } });
      if (url === "/api/symphony/runs") return json({ runs: [] });
      if (url.startsWith("/api/symphony/tickets/preview")) return json({ tickets: [{ sourceKind: "matrix", externalId: "ticket_123", identifier: "MAT-123", title: "Internal ticket", stateName: "Todo", labels: [] }] });
      if (url === "/api/symphony/tickets/assign") return json({ run: { id: "run_1", status: "running" } });
      return json({});
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers a desktop-dense manual assign action for previewed tickets", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("Symphony assignments")).toBeTruthy());
    fireEvent.click(screen.getByText("Preview tickets"));
    await waitFor(() => expect(screen.getByText("Internal ticket")).toBeTruthy());
    fireEvent.click(screen.getByText("Assign to Symphony"));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/symphony/tickets/assign")).toBe(true));
  });
});
