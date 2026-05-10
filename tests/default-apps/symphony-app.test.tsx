// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/symphony/src/App.js";

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Symphony app", () => {
  let runtimeConfigShouldFail = false;
  let availableLabels: Array<{ id: string; name: string }> = [];
  let createdIssues: unknown[] = [];

  beforeEach(() => {
    runtimeConfigShouldFail = false;
    availableLabels = [{ id: "label_symphony", name: "symphony" }];
    createdIssues = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/bridge/data") && init?.method !== "POST") {
        return json({ value: null });
      }
      if (url === "/api/bridge/data" && init?.method === "POST") {
        return json({ ok: true });
      }
      if (url === "/api/symphony/status") {
        return json({
          running: false,
          pid: null,
          startedAt: null,
          lastExitAt: null,
          lastExitCode: null,
          dashboardUrl: "http://127.0.0.1:4066",
          linearApiKeyConfigured: true,
          config: {
            version: 1,
            serviceRoot: "/home/matrixos/code/symphony/elixir",
            binPath: "./bin/symphony",
            workflowPath: "/app/WORKFLOW.md",
            port: 4066,
            tracker: {
              kind: "linear",
              teamKey: "MAT",
              requiredLabels: ["symphony"],
              activeStates: ["Todo", "In Progress", "Merging", "Rework"],
            },
          },
        });
      }
      if (url === "/api/symphony/config" && init?.method === "POST") {
        if (runtimeConfigShouldFail) return json({ error: "failed" }, { status: 500 });
        return json({
          version: 1,
          serviceRoot: "/home/matrixos/code/symphony/elixir",
          binPath: "./bin/symphony",
          workflowPath: "/app/WORKFLOW.md",
          port: 4066,
          tracker: {
            kind: "linear",
            teamKey: "OPS",
            requiredLabels: ["symphony"],
            activeStates: ["Todo", "In Progress", "Merging", "Rework"],
          },
        });
      }
      if (url === "/api/integrations") {
        return json([{ id: "conn_linear", service: "linear", account_label: "Linear", status: "connected" }]);
      }
      if (url === "/api/integrations/call" && init?.method === "POST") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { action?: string } : {};
        if (body.action === "list_teams") {
          return json({ data: { teams: { nodes: [
            { id: "team_mat", key: "MAT", name: "Matrix" },
            { id: "team_ops", key: "OPS", name: "Ops" },
          ] } } });
        }
        if (body.action === "list_projects") {
          return json({ data: { projects: { nodes: [] } } });
        }
        if (body.action === "list_workflow_states") {
          return json({ data: { workflowStates: { nodes: [] } } });
        }
        if (body.action === "list_issues") {
          return json({ data: { issues: { nodes: [] } } });
        }
        if (body.action === "graphql") {
          return json({ data: { issueLabels: { nodes: availableLabels } } });
        }
        if (body.action === "create_issue") {
          createdIssues.push(body.params);
          return json({ data: { issueCreate: { success: true } } });
        }
      }
      return json({});
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces runtime config save failures before writing app config", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Team")).toBeTruthy());
    runtimeConfigShouldFail = true;

    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team_ops" } });

    await waitFor(() => expect(screen.getByText("Symphony settings could not be saved.")).toBeTruthy());
    expect(global.fetch).not.toHaveBeenCalledWith("/api/bridge/data", expect.objectContaining({ method: "POST" }));
    expect(warnSpy).toHaveBeenCalledWith("[symphony] config save failed:", "runtime_config_failed");
  });

  it("does not create issues when any required Linear label is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Required labels")).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_mat"));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Required labels"), { target: { value: "symphony, urgent" } });
      fireEvent.change(screen.getByPlaceholderText("New Linear ticket"), { target: { value: "Follow up" } });
    });
    const createButton = screen.getByRole("button", { name: /^Create$/ }) as HTMLButtonElement;
    await waitFor(() => expect(createButton.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(createButton);
    });

    await waitFor(() => expect(screen.getByText("Issue could not be created.")).toBeTruthy());
    expect(createdIssues).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith("[symphony] issue creation failed:", "required_label_missing");
  });
});
