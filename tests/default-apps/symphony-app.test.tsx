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
  let appConfigWriteShouldFail = false;
  let storedConfig: string | null = null;
  let availableLabels: Array<{ id: string; name: string }> = [];
  let availableLabelPages: Record<string, { nodes: Array<{ id: string; name: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> | null = null;
  let linearProjects: Array<{ id: string; name: string; slugId?: string; teams?: { nodes?: Array<{ id: string; key?: string; name?: string }> } }> = [];
  let linearProjectPages: Record<string, { nodes: Array<{ id: string; name: string; slugId?: string; teams?: { nodes?: Array<{ id: string; key?: string; name?: string }> } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> | null = null;
  let workflowStates: Array<{ id: string; name: string; type?: string; color?: string; team?: { id: string; key?: string; name?: string } }> = [];
  let createdIssues: unknown[] = [];
  let listedIssues: unknown[] = [];
  let listedIssuesByProjectId: Record<string, unknown[]> = {};
  let listedIssuePages: Record<string, { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> | null = null;
  let integrationCalls: Array<{ action?: string; params?: Record<string, unknown> }> = [];
  let runtimeActiveStates: string[] = [];
  let runtimeTeamKey = "MAT";
  let runtimeRunning = false;
  let runtimePort = 4066;
  let startRuntimeFailureCode: string | null = null;
  let runtimeStatusPromise: Promise<Response> | null = null;
  let runtimeConfigSavePromise: Promise<Response> | null = null;

  beforeEach(() => {
    runtimeConfigShouldFail = false;
    appConfigWriteShouldFail = false;
    storedConfig = null;
    availableLabels = [{ id: "label_symphony", name: "symphony" }];
    availableLabelPages = null;
    linearProjects = [];
    linearProjectPages = null;
    workflowStates = [];
    createdIssues = [];
    listedIssues = [];
    listedIssuesByProjectId = {};
    listedIssuePages = null;
    integrationCalls = [];
    runtimeActiveStates = ["Todo", "In Progress", "Merging", "Rework"];
    runtimeTeamKey = "MAT";
    runtimeRunning = false;
    runtimePort = 4066;
    startRuntimeFailureCode = null;
    runtimeStatusPromise = null;
    runtimeConfigSavePromise = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/bridge/data") && init?.method !== "POST") {
        return json({ value: storedConfig });
      }
      if (url === "/api/bridge/data" && init?.method === "POST") {
        if (appConfigWriteShouldFail) return json({ error: "failed" }, { status: 500 });
        const body = typeof init.body === "string"
          ? JSON.parse(init.body) as { action?: string; value?: string }
          : {};
        if (body.action === "write") storedConfig = body.value ?? null;
        return json({ ok: true });
      }
      if (url === "/api/symphony/status") {
        if (runtimeStatusPromise) return await runtimeStatusPromise;
        return json({
          running: runtimeRunning,
          pid: runtimeRunning ? 123 : null,
          startedAt: runtimeRunning ? "2026-05-10T00:00:00.000Z" : null,
          lastExitAt: null,
          lastExitCode: null,
          dashboardUrl: `http://127.0.0.1:${runtimePort}`,
          linearApiKeyConfigured: true,
          config: {
            version: 1,
            serviceRoot: "/home/matrixos/code/symphony/elixir",
            binPath: "./bin/symphony",
            workflowPath: "/app/WORKFLOW.md",
            port: runtimePort,
            tracker: {
              kind: "linear",
              teamKey: runtimeTeamKey,
              requiredLabels: ["symphony"],
              activeStates: runtimeActiveStates,
            },
          },
        });
      }
      if (url === "/api/symphony/config" && init?.method === "POST") {
        if (runtimeConfigSavePromise) return await runtimeConfigSavePromise;
        if (runtimeConfigShouldFail) return json({ error: "failed" }, { status: 500 });
        const requestedConfig = typeof init.body === "string"
          ? JSON.parse(init.body) as Partial<{
            serviceRoot: string;
            binPath: string;
            workflowPath: string;
            port: number;
            tracker: { teamKey: string; requiredLabels: string[]; activeStates: string[] };
          }>
          : {};
        return json({
          version: 1,
          serviceRoot: requestedConfig.serviceRoot ?? "/home/matrixos/code/symphony/elixir",
          binPath: requestedConfig.binPath ?? "./bin/symphony",
          workflowPath: requestedConfig.workflowPath ?? "/app/WORKFLOW.md",
          port: requestedConfig.port ?? runtimePort,
          tracker: {
            kind: "linear",
            teamKey: requestedConfig.tracker?.teamKey ?? "OPS",
            requiredLabels: requestedConfig.tracker?.requiredLabels ?? ["symphony"],
            activeStates: requestedConfig.tracker?.activeStates ?? runtimeActiveStates,
          },
        });
      }
      if (url === "/api/symphony/start" && init?.method === "POST") {
        if (startRuntimeFailureCode) {
          return json({ error: { code: startRuntimeFailureCode, message: "Start failed" } }, { status: 409 });
        }
        const requestedConfig = typeof init.body === "string"
          ? JSON.parse(init.body) as Partial<{ port: number; tracker: { activeStates: string[] } }>
          : {};
        return json({
          running: true,
          pid: 123,
          startedAt: "2026-05-10T00:00:00.000Z",
          lastExitAt: null,
          lastExitCode: null,
          dashboardUrl: `http://127.0.0.1:${requestedConfig.port ?? runtimePort}`,
          linearApiKeyConfigured: true,
          config: {
            version: 1,
            serviceRoot: "/home/matrixos/code/symphony/elixir",
            binPath: "./bin/symphony",
            workflowPath: "/app/WORKFLOW.md",
            port: requestedConfig.port ?? runtimePort,
            tracker: {
              kind: "linear",
              teamKey: runtimeTeamKey,
              requiredLabels: ["symphony"],
              activeStates: requestedConfig.tracker?.activeStates ?? runtimeActiveStates,
            },
          },
        });
      }
      if (url === "/api/integrations") {
        return json([{ id: "conn_linear", service: "linear", account_label: "Linear", status: "connected" }]);
      }
      if (url === "/api/integrations/call" && init?.method === "POST") {
        const body = typeof init.body === "string"
          ? JSON.parse(init.body) as { action?: string; params?: Record<string, unknown> & { after?: string; variables?: { after?: string | null } } }
          : {};
        integrationCalls.push({ action: body.action, params: body.params });
        if (body.action === "list_teams") {
          return json({ data: { teams: { nodes: [
            { id: "team_mat", key: "MAT", name: "Matrix" },
            { id: "team_ops", key: "OPS", name: "Ops" },
          ] } } });
        }
        if (body.action === "list_projects") {
          const after = body.params?.after ?? "";
          const page = linearProjectPages?.[after] ?? {
            nodes: linearProjects,
            pageInfo: { hasNextPage: false, endCursor: null },
          };
          return json({ data: { projects: page } });
        }
        if (body.action === "list_workflow_states") {
          return json({ data: { workflowStates: { nodes: workflowStates } } });
        }
        if (body.action === "list_issues") {
          const after = body.params?.after ?? "";
          const projectId = typeof body.params?.projectId === "string" ? body.params.projectId : "";
          const projectIssues = listedIssuesByProjectId[projectId] ?? listedIssues;
          const page = listedIssuePages?.[after] ?? { nodes: projectIssues, pageInfo: { hasNextPage: false, endCursor: null } };
          return json({ data: { issues: page } });
        }
        if (body.action === "graphql") {
          const after = body.params?.variables?.after ?? "";
          const page = availableLabelPages?.[after] ?? { nodes: availableLabels, pageInfo: { hasNextPage: false, endCursor: null } };
          return json({ data: { issueLabels: page } });
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
    expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_mat");
    expect(global.fetch).not.toHaveBeenCalledWith("/api/bridge/data", expect.objectContaining({ method: "POST" }));
    expect(warnSpy).toHaveBeenCalledWith("[symphony] config save failed:", "runtime_config_failed");
  });

  it("rolls back text-field config edits when the app config write fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    storedConfig = JSON.stringify({
      githubRepo: "HamedMP/matrix-os",
      cloneUrl: "git@github.com:HamedMP/matrix-os.git",
    });
    render(<App />);

    const repoInput = await screen.findByLabelText("GitHub repo") as HTMLInputElement;
    await waitFor(() => expect(repoInput.value).toBe("HamedMP/matrix-os"));
    appConfigWriteShouldFail = true;

    await act(async () => {
      fireEvent.change(repoInput, { target: { value: "HamedMP/other-repo" } });
      fireEvent.blur(repoInput);
    });

    await waitFor(() => expect(screen.getByText("Symphony settings could not be saved.")).toBeTruthy());
    expect(repoInput.value).toBe("HamedMP/matrix-os");
    expect(JSON.parse(storedConfig ?? "{}")).toEqual(expect.objectContaining({
      githubRepo: "HamedMP/matrix-os",
    }));
    expect(warnSpy).toHaveBeenCalledWith("[symphony] config save failed:", "config_write_failed");
  });

  it("does not restore a saved Linear project from another team", async () => {
    runtimeTeamKey = "OPS";
    storedConfig = JSON.stringify({
      teamId: "team_ops",
      teamKey: "OPS",
      projectId: "project_mat",
      projectSlug: "matrix-os",
    });
    linearProjects = [
      { id: "project_mat", name: "Matrix OS", slugId: "matrix-os", teams: { nodes: [{ id: "team_mat", key: "MAT", name: "Matrix" }] } },
      { id: "project_ops", name: "Ops", slugId: "ops", teams: { nodes: [{ id: "team_ops", key: "OPS", name: "Ops" }] } },
    ];
    render(<App />);

    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_ops"));
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("");
  });

  it("pages Linear projects before restoring a saved project", async () => {
    storedConfig = JSON.stringify({
      teamId: "team_mat",
      teamKey: "MAT",
      projectId: "project_late",
      projectSlug: "late-project",
    });
    linearProjectPages = {
      "": {
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: "cursor_1" },
      },
      cursor_1: {
        nodes: [
          { id: "project_late", name: "Late project", slugId: "late-project", teams: { nodes: [{ id: "team_mat", key: "MAT", name: "Matrix" }] } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    render(<App />);

    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_mat"));
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("project_late");
    const projectCalls = integrationCalls.filter((call) => call.action === "list_projects");
    expect(projectCalls.map((call) => call.params?.after ?? "")).toEqual(["", "cursor_1"]);
  });

  it("clears the selected Linear project when switching teams", async () => {
    storedConfig = JSON.stringify({
      teamId: "team_mat",
      teamKey: "MAT",
      projectId: "project_mat",
      projectSlug: "matrix-os",
    });
    linearProjects = [
      { id: "project_mat", name: "Matrix OS", slugId: "matrix-os", teams: { nodes: [{ id: "team_mat", key: "MAT", name: "Matrix" }] } },
      { id: "project_ops", name: "Ops", slugId: "ops", teams: { nodes: [{ id: "team_ops", key: "OPS", name: "Ops" }] } },
    ];
    render(<App />);

    await waitFor(() => expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("project_mat"));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team_ops" } });
    });

    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_ops"));
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("");
    expect(JSON.parse(storedConfig ?? "{}")).toEqual(expect.objectContaining({
      teamId: "team_ops",
      teamKey: "OPS",
      projectId: "",
      projectSlug: "",
    }));
  });

  it("keeps Team and Project selections visible while config saves are in flight", async () => {
    storedConfig = JSON.stringify({
      teamId: "team_mat",
      teamKey: "MAT",
      projectId: "project_mat",
      projectSlug: "matrix-os",
    });
    linearProjects = [
      { id: "project_mat", name: "Matrix OS", slugId: "matrix-os", teams: { nodes: [{ id: "team_mat", key: "MAT", name: "Matrix" }] } },
      { id: "project_ops", name: "Ops", slugId: "ops", teams: { nodes: [{ id: "team_ops", key: "OPS", name: "Ops" }] } },
    ];
    let resolveRuntimeConfig: (response: Response) => void = () => {};
    runtimeConfigSavePromise = new Promise<Response>((resolve) => {
      resolveRuntimeConfig = resolve;
    });
    render(<App />);

    await waitFor(() => expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("project_mat"));
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team_ops" } });

    expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_ops");
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("");

    resolveRuntimeConfig(json({
      version: 1,
      serviceRoot: "/home/matrixos/code/symphony/elixir",
      binPath: "./bin/symphony",
      workflowPath: "/app/WORKFLOW.md",
      port: runtimePort,
      tracker: {
        kind: "linear",
        teamKey: "OPS",
        requiredLabels: ["symphony"],
        activeStates: runtimeActiveStates,
      },
    }));
    await waitFor(() => expect(JSON.parse(storedConfig ?? "{}")).toEqual(expect.objectContaining({
      teamId: "team_ops",
      projectId: "",
    })));
  });

  it("refreshes the Linear board after Project selection changes", async () => {
    storedConfig = JSON.stringify({
      teamId: "team_mat",
      teamKey: "MAT",
      projectId: "project_mat",
      projectSlug: "matrix-os",
    });
    linearProjects = [
      { id: "project_mat", name: "Matrix OS", slugId: "matrix-os", teams: { nodes: [{ id: "team_mat", key: "MAT", name: "Matrix" }] } },
      { id: "project_other", name: "Other", slugId: "other", teams: { nodes: [{ id: "team_mat", key: "MAT", name: "Matrix" }] } },
    ];
    listedIssuesByProjectId = {
      project_mat: [{
        id: "issue_matrix",
        identifier: "MAT-1",
        title: "Matrix project issue",
        url: "https://linear.app/matrix-os/issue/MAT-1",
        state: { id: "state_todo", name: "Todo" },
        labels: { nodes: [{ id: "label_symphony", name: "symphony" }] },
      }],
      project_other: [{
        id: "issue_other",
        identifier: "MAT-2",
        title: "Other project issue",
        url: "https://linear.app/matrix-os/issue/MAT-2",
        state: { id: "state_todo", name: "Todo" },
        labels: { nodes: [{ id: "label_symphony", name: "symphony" }] },
      }],
    };
    render(<App />);

    await waitFor(() => expect(screen.getByText("Matrix project issue")).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Project"), { target: { value: "project_other" } });
    });

    await waitFor(() => expect(screen.getByText("Other project issue")).toBeTruthy());
    expect(screen.queryByText("Matrix project issue")).toBeNull();
    expect(integrationCalls.filter((call) => call.action === "list_issues").at(-1)?.params).toMatchObject({
      projectId: "project_other",
    });
  });

  it("preserves comma-separated list edits while typing", async () => {
    render(<App />);

    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_mat"));
    const requiredLabelsInput = screen.getByLabelText("Required labels") as HTMLInputElement;
    const activeStatesInput = screen.getByLabelText("Active states") as HTMLInputElement;

    await act(async () => {
      fireEvent.focus(requiredLabelsInput);
      fireEvent.change(requiredLabelsInput, { target: { value: "symphony," } });
    });
    expect(requiredLabelsInput.value).toBe("symphony,");
    await act(async () => {
      fireEvent.change(requiredLabelsInput, { target: { value: "symphony, urgent" } });
    });
    expect(requiredLabelsInput.value).toBe("symphony, urgent");

    await act(async () => {
      fireEvent.focus(activeStatesInput);
      fireEvent.change(activeStatesInput, { target: { value: "Ready," } });
    });
    expect(activeStatesInput.value).toBe("Ready,");
    await act(async () => {
      fireEvent.change(activeStatesInput, { target: { value: "Ready, Reviewing" } });
    });
    expect(activeStatesInput.value).toBe("Ready, Reviewing");
  });

  it("quotes local runner command paths", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Symphony checkout")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Symphony checkout"), { target: { value: "/home/matrix user/code/symphony/elixir" } });
    fireEvent.change(screen.getByLabelText("Runner binary"), { target: { value: "./bin/my symphony" } });
    fireEvent.change(screen.getByLabelText("Workflow path"), { target: { value: "/app/Work Flow.md" } });

    expect(screen.getByText((content) => (
      content.includes("cd '/home/matrix user/code/symphony/elixir'") &&
      content.includes("'./bin/my symphony'") &&
      content.includes("'/app/Work Flow.md'")
    ))).toBeTruthy();
  });

  it("keeps launch-time runner status visible after saving config while running", async () => {
    runtimeRunning = true;
    runtimePort = 4077;
    render(<App />);

    await waitFor(() => expect(screen.getByText("Running :4077")).toBeTruthy());
    const portInput = screen.getByLabelText("Runner port") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(portInput, { target: { value: "4088" } });
      fireEvent.blur(portInput);
    });

    await waitFor(() => {
      const configCalls = vi.mocked(global.fetch).mock.calls.filter(([input]) => input === "/api/symphony/config");
      expect(configCalls.length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Running :4077")).toBeTruthy();
    expect(screen.queryByText("Running :4088")).toBeNull();
  });

  it("shows a specific safe runner start error from the API code", async () => {
    startRuntimeFailureCode = "symphony_path_not_allowed";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Start/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start/ }));
    });

    await waitFor(() => expect(screen.getByText("Symphony runner paths must stay inside the allowed local checkout roots.")).toBeTruthy());
    expect(warnSpy).toHaveBeenCalledWith("[symphony] runtime start failed:", "symphony_path_not_allowed");
  });

  it("keeps Start disabled until runtime config loads", async () => {
    let resolveRuntimeStatus: (response: Response) => void = () => {};
    runtimeStatusPromise = new Promise<Response>((resolve) => {
      resolveRuntimeStatus = resolve;
    });
    render(<App />);

    const startButton = screen.getByRole("button", { name: /Start/ }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    fireEvent.click(startButton);
    expect(vi.mocked(global.fetch).mock.calls.filter(([input]) => input === "/api/symphony/start")).toHaveLength(0);

    resolveRuntimeStatus(json({
      running: false,
      pid: null,
      startedAt: null,
      lastExitAt: null,
      lastExitCode: null,
      dashboardUrl: `http://127.0.0.1:${runtimePort}`,
      linearApiKeyConfigured: true,
      config: {
        version: 1,
        serviceRoot: "/home/matrixos/code/symphony/elixir",
        binPath: "./bin/symphony",
        workflowPath: "/home/matrixos/system/symphony/WORKFLOW.md",
        port: runtimePort,
        tracker: {
          kind: "linear",
          teamKey: runtimeTeamKey,
          requiredLabels: ["symphony"],
          activeStates: runtimeActiveStates,
        },
      },
    }));

    await waitFor(() => expect(startButton.disabled).toBe(false));
  });

  it("starts with generic repository defaults before runtime config loads", async () => {
    render(<App />);

    expect((screen.getByLabelText("GitHub repo") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Clone URL") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Project slug") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Symphony checkout") as HTMLInputElement).value).toBe("~/code/symphony/elixir");
    expect((screen.getByLabelText("Workflow path") as HTMLInputElement).value).toBe("~/code/symphony/WORKFLOW.md");
  });

  it("does not create issues when any required Linear label is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Required labels")).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_mat"));
    await act(async () => {
      const requiredLabelsInput = screen.getByLabelText("Required labels");
      fireEvent.focus(requiredLabelsInput);
      fireEvent.change(requiredLabelsInput, { target: { value: "symphony, urgent" } });
      fireEvent.blur(requiredLabelsInput);
      fireEvent.change(screen.getByPlaceholderText("New Linear ticket"), { target: { value: "Follow up" } });
    });
    const createButton = screen.getByRole("button", { name: /^Create$/ }) as HTMLButtonElement;
    await waitFor(() => expect(createButton.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(createButton);
    });

    await waitFor(() => expect(screen.getByText("One or more required labels could not be found in the selected Linear team. Check that all required labels exist.")).toBeTruthy());
    expect(createdIssues).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[symphony] issue creation failed:",
      "One or more required labels could not be found in the selected Linear team. Check that all required labels exist.",
    );
  });

  it("finds required Linear labels on later pages before creating issues", async () => {
    workflowStates = [{ id: "state_todo", name: "Todo", type: "unstarted", color: "#6b7280", team: { id: "team_mat" } }];
    availableLabelPages = {
      "": {
        nodes: [{ id: "label_symphony", name: "symphony" }],
        pageInfo: { hasNextPage: true, endCursor: "label_cursor_1" },
      },
      label_cursor_1: {
        nodes: [{ id: "label_urgent", name: "urgent" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    render(<App />);

    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_mat"));
    await act(async () => {
      const requiredLabelsInput = screen.getByLabelText("Required labels");
      fireEvent.focus(requiredLabelsInput);
      fireEvent.change(requiredLabelsInput, { target: { value: "symphony, urgent" } });
      fireEvent.blur(requiredLabelsInput);
      fireEvent.change(screen.getByPlaceholderText("New Linear ticket"), { target: { value: "Follow up" } });
    });
    const createButton = screen.getByRole("button", { name: /^Create$/ }) as HTMLButtonElement;
    await waitFor(() => expect(createButton.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(createButton);
    });

    await waitFor(() => expect(createdIssues).toHaveLength(1));
    expect(createdIssues[0]).toMatchObject({
      labelIds: ["label_symphony", "label_urgent"],
      stateId: "state_todo",
    });
  });

  it("does not reuse workflow state ids from a different Linear team", async () => {
    workflowStates = [{ id: "state_old_team", name: "Todo", type: "unstarted", color: "#6b7280", team: { id: "team_old" } }];
    render(<App />);

    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_mat"));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("New Linear ticket"), { target: { value: "Follow up" } });
    });
    const createButton = screen.getByRole("button", { name: /^Create$/ }) as HTMLButtonElement;
    await waitFor(() => expect(createButton.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(createButton);
    });

    await waitFor(() => expect(createdIssues).toHaveLength(1));
    expect(createdIssues[0]).not.toMatchObject({ stateId: "state_old_team" });
  });

  it("filters the board by every required Linear label", async () => {
    listedIssues = [
      {
        id: "issue_one",
        identifier: "MAT-1",
        title: "Only first label",
        url: "https://linear.app/matrix-os/issue/MAT-1",
        state: { id: "state_todo", name: "Todo" },
        labels: { nodes: [{ id: "label_symphony", name: "symphony" }] },
      },
      {
        id: "issue_two",
        identifier: "MAT-2",
        title: "All required labels",
        url: "https://linear.app/matrix-os/issue/MAT-2",
        state: { id: "state_todo", name: "Todo" },
        labels: { nodes: [
          { id: "label_symphony", name: "symphony" },
          { id: "label_urgent", name: "urgent" },
        ] },
      },
    ];
    render(<App />);

    await waitFor(() => expect(screen.getByText("Only first label")).toBeTruthy());
    await act(async () => {
      const requiredLabelsInput = screen.getByLabelText("Required labels");
      fireEvent.focus(requiredLabelsInput);
      fireEvent.change(requiredLabelsInput, { target: { value: "symphony, urgent" } });
      fireEvent.blur(requiredLabelsInput);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Sync Linear/ }));
    });

    await waitFor(() => expect(screen.queryByText("Only first label")).toBeNull());
    expect(screen.getByText("All required labels")).toBeTruthy();
  });

  it("fetches additional issue pages before applying every required label", async () => {
    listedIssuePages = {
      "": {
        nodes: Array.from({ length: 50 }, (_, index) => ({
          id: `issue_first_${index}`,
          identifier: `MAT-${index + 1}`,
          title: index === 0 ? "First page only" : `First page ${index}`,
          url: `https://linear.app/matrix-os/issue/MAT-${index + 1}`,
          state: { id: "state_todo", name: "Todo" },
          labels: { nodes: [{ id: "label_symphony", name: "symphony" }] },
        })),
        pageInfo: { hasNextPage: true, endCursor: "cursor_1" },
      },
      cursor_1: {
        nodes: [{
          id: "issue_second",
          identifier: "MAT-99",
          title: "Second page full match",
          url: "https://linear.app/matrix-os/issue/MAT-99",
          state: { id: "state_todo", name: "Todo" },
          labels: { nodes: [
            { id: "label_symphony", name: "symphony" },
            { id: "label_urgent", name: "urgent" },
          ] },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    render(<App />);

    await waitFor(() => expect(screen.getByText("First page only")).toBeTruthy());
    expect(screen.queryByText("Second page full match")).toBeNull();
    await act(async () => {
      const requiredLabelsInput = screen.getByLabelText("Required labels");
      fireEvent.focus(requiredLabelsInput);
      fireEvent.change(requiredLabelsInput, { target: { value: "symphony, urgent" } });
      fireEvent.blur(requiredLabelsInput);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Sync Linear/ }));
    });

    await waitFor(() => expect(screen.getByText("Second page full match")).toBeTruthy());
    expect(screen.queryByText("First page only")).toBeNull();
  });

  it("warns when multi-label issue filtering exhausts the page cap", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    listedIssuePages = Object.fromEntries(Array.from({ length: 5 }, (_, index) => {
      const cursor = index === 0 ? "" : `cursor_${index}`;
      return [cursor, {
        nodes: [{
          id: `issue_page_${index}`,
          identifier: `MAT-${index + 1}`,
          title: `Partial label page ${index + 1}`,
          url: `https://linear.app/matrix-os/issue/MAT-${index + 1}`,
          state: { id: "state_todo", name: "Todo" },
          labels: { nodes: [{ id: "label_symphony", name: "symphony" }] },
        }],
        pageInfo: { hasNextPage: true, endCursor: `cursor_${index + 1}` },
      }];
    }));
    render(<App />);

    await waitFor(() => expect(screen.getByText("Partial label page 1")).toBeTruthy());
    await act(async () => {
      const requiredLabelsInput = screen.getByLabelText("Required labels");
      fireEvent.focus(requiredLabelsInput);
      fireEvent.change(requiredLabelsInput, { target: { value: "symphony, urgent" } });
      fireEvent.blur(requiredLabelsInput);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Sync Linear/ }));
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "[symphony] Linear issue label filter reached the page cap before filling the board",
        expect.objectContaining({ collected: 0, pages: 5, requiredLabels: 2 }),
      );
    });
    expect(screen.getByText("Board is incomplete: only 0 of 50 target issues found after scanning 5 pages. Consider reducing the number of required labels.")).toBeTruthy();
  });

  it("does not warn when the final scanned issue page is complete", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    listedIssuePages = Object.fromEntries(Array.from({ length: 5 }, (_, index) => {
      const cursor = index === 0 ? "" : `cursor_${index}`;
      return [cursor, {
        nodes: [{
          id: `issue_page_${index}`,
          identifier: `MAT-${index + 1}`,
          title: `Partial label page ${index + 1}`,
          url: `https://linear.app/matrix-os/issue/MAT-${index + 1}`,
          state: { id: "state_todo", name: "Todo" },
          labels: { nodes: [{ id: "label_symphony", name: "symphony" }] },
        }],
        pageInfo: { hasNextPage: index < 4, endCursor: index < 4 ? `cursor_${index + 1}` : null },
      }];
    }));
    render(<App />);

    await waitFor(() => expect(screen.getByText("Partial label page 1")).toBeTruthy());
    await act(async () => {
      const requiredLabelsInput = screen.getByLabelText("Required labels");
      fireEvent.focus(requiredLabelsInput);
      fireEvent.change(requiredLabelsInput, { target: { value: "symphony, urgent" } });
      fireEvent.blur(requiredLabelsInput);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Sync Linear/ }));
    });

    await waitFor(() => expect(screen.queryByText(/Board is incomplete:/)).toBeNull());
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[symphony] Linear issue label filter reached the page cap before filling the board",
      expect.anything(),
    );
  });

  it("omits the Linear label filter when required labels are empty", async () => {
    listedIssues = [{
      id: "issue_unlabeled",
      identifier: "MAT-8",
      title: "Unlabeled task",
      url: "https://linear.app/matrix-os/issue/MAT-8",
      state: { id: "state_todo", name: "Todo" },
      labels: { nodes: [] },
    }];
    render(<App />);

    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_mat"));
    await act(async () => {
      const requiredLabelsInput = screen.getByLabelText("Required labels");
      fireEvent.focus(requiredLabelsInput);
      fireEvent.change(requiredLabelsInput, { target: { value: "" } });
      fireEvent.blur(requiredLabelsInput);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Sync Linear/ }));
    });

    await waitFor(() => expect(screen.getByText("Unlabeled task")).toBeTruthy());
    const listIssuesCalls = integrationCalls.filter((call) => call.action === "list_issues");
    expect(listIssuesCalls.at(-1)?.params).not.toHaveProperty("labelName");
  });

  it("uses configured active states for board tabs and workflow state creation", async () => {
    runtimeActiveStates = ["Ready", "Reviewing"];
    render(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Ready" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Reviewing" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rework" })).toBeNull();
    await waitFor(() => {
      const listIssuesCalls = integrationCalls.filter((call) => call.action === "list_issues");
      expect(listIssuesCalls.at(-1)?.params).toMatchObject({ state: "Ready" });
    });

    const createStatesButton = screen.getByRole("button", { name: /Create states/ }) as HTMLButtonElement;
    await waitFor(() => expect(createStatesButton.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(createStatesButton);
    });

    await waitFor(() => {
      const createdStates = integrationCalls.filter((call) => call.action === "create_workflow_state").map((call) => call.params);
      expect(createdStates).toEqual([
        { teamId: "team_mat", name: "Ready", color: "#2563eb", type: "started" },
        { teamId: "team_mat", name: "Reviewing", color: "#2563eb", type: "started" },
      ]);
    });
  });

  it("creates workflow states for the selected team when old team states are loaded", async () => {
    workflowStates = [
      { id: "state_mat_todo", name: "Todo", type: "unstarted", color: "#6b7280", team: { id: "team_mat" } },
      { id: "state_mat_progress", name: "In Progress", type: "started", color: "#2563eb", team: { id: "team_mat" } },
      { id: "state_mat_merging", name: "Merging", type: "started", color: "#0f783c", team: { id: "team_mat" } },
      { id: "state_mat_rework", name: "Rework", type: "started", color: "#db6e1f", team: { id: "team_mat" } },
    ];
    render(<App />);

    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_mat"));
    const createStatesButton = await screen.findByRole("button", { name: /Create states/ }) as HTMLButtonElement;
    await waitFor(() => expect(createStatesButton.disabled).toBe(true));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team_ops" } });
    });

    await waitFor(() => expect((screen.getByLabelText("Team") as HTMLSelectElement).value).toBe("team_ops"));
    await waitFor(() => expect(createStatesButton.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(createStatesButton);
    });

    await waitFor(() => {
      const createdStates = integrationCalls.filter((call) => call.action === "create_workflow_state").map((call) => call.params);
      expect(createdStates).toEqual([
        { teamId: "team_ops", name: "Todo", color: "#6b7280", type: "unstarted" },
        { teamId: "team_ops", name: "In Progress", color: "#2563eb", type: "started" },
        { teamId: "team_ops", name: "Merging", color: "#0f783c", type: "started" },
        { teamId: "team_ops", name: "Rework", color: "#db6e1f", type: "started" },
      ]);
    });
  });
});
