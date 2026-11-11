import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createTerminalAgentOrchestrationRoutes } from "../../packages/gateway/src/terminal-agent/agent-routes.js";
import { TerminalAgentVerbError } from "../../packages/gateway/src/terminal-agent/verbs.js";

const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const tabId = "tt_0123456789abcdef0123456789abcdef";
const caller = { sessionName: `matrix-w-${"f".repeat(32)}`, paneId: "4" };

function app(options: { userId?: string; agents?: Record<string, unknown> } = {}) {
  const agents = {
    run: vi.fn(async () => ({ ref: { workspaceId, tabId }, tab: { id: tabId }, firstMessage: { sent: true } })),
    describe: vi.fn(async () => ({ labels: { role: "review" } })),
    label: vi.fn(async () => ({ labels: { role: "lead" } })),
    reportToParent: vi.fn(async () => ({ sent: true, parent: { workspaceId, tabId } })),
    resolveCaller: vi.fn(async () => ({ workspaceId, tabId })),
    waitChildren: vi.fn(async () => ({ reason: "idle" })),
    ...options.agents,
  };
  const withProject = vi.fn(async (_owner: string, _project: string | undefined, _kind: string, operation: () => Promise<unknown>) => operation());
  const withWorkspace = vi.fn(async (_owner: string, _workspace: string, _kind: string, operation: () => Promise<unknown>) => operation());
  const hono = new Hono();
  hono.route("/api/terminal", createTerminalAgentOrchestrationRoutes({
    agents: agents as never,
    templates: { list: async () => [{ name: "reviewer", description: "Reviews", command: "secret-cmd --token x", body: "b", source: "matrix" as const }], get: async () => undefined },
    getPrincipal: () => ({ userId: options.userId ?? "user_owner", source: "jwt" as const }),
    terminalOwnerIds: ["user_owner"],
    projectAdmission: { withProject, withWorkspace } as never,
  }));
  return { hono, agents, withProject, withWorkspace };
}

const post = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("terminal agent orchestration routes", () => {
  it("hides orchestration from principals that do not own the terminals", async () => {
    const { hono, agents } = app({ userId: "user_other" });
    for (const [path, init] of [
      ["/api/terminal/templates", undefined],
      ["/api/terminal/agents/run", post({ name: "x", cwd: "" })],
      ["/api/terminal/agents/report", post({ caller, text: "hi" })],
      [`/api/terminal/workspaces/${workspaceId}/tabs/${tabId}/labels`, post({ set: { a: "b" } }, "PATCH")],
    ] as const) {
      expect((await hono.request(path, init)).status, path).toBe(404);
    }
    expect(agents.run).not.toHaveBeenCalled();
  });

  it("lists templates by name and description without their commands", async () => {
    const { hono } = app();
    const response = await hono.request("/api/terminal/templates");
    expect(await response.json()).toEqual({ templates: [{ name: "reviewer", description: "Reviews", source: "matrix" }] });
  });

  it("runs an agent inside project admission and validates its shape", async () => {
    const { hono, agents, withProject } = app();
    const body = { projectId: "matrix-os", name: "review", cwd: "projects/app", template: "reviewer", task: "Review x", caller, labels: { role: "review" } };
    const response = await hono.request("/api/terminal/agents/run", post(body));
    expect(response.status).toBe(201);
    expect(withProject).toHaveBeenCalledWith("user_owner", "matrix-os", "run", expect.any(Function));
    expect(agents.run).toHaveBeenCalledWith(body);
    for (const bad of [
      { name: "x", cwd: "", argv: ["sh"], template: "reviewer" },
      { name: "x", cwd: "", template: "../etc" },
      { name: "x", cwd: "", labels: { "Bad Key": "v" } },
      { name: "x", cwd: "", caller: { sessionName: "mine", paneId: "1" } },
      { name: "x", cwd: "", extra: true },
    ]) {
      expect((await hono.request("/api/terminal/agents/run", post(bad))).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("labels a tab inside workspace admission", async () => {
    const { hono, agents, withWorkspace } = app();
    const response = await hono.request(`/api/terminal/workspaces/${workspaceId}/tabs/${tabId}/labels`, post({ set: { role: "lead" }, remove: ["old"] }, "PATCH"));
    expect(response.status).toBe(200);
    expect(withWorkspace).toHaveBeenCalledWith("user_owner", workspaceId, "write", expect.any(Function));
    expect(agents.label).toHaveBeenCalledWith({ workspaceId, tabId }, { set: { role: "lead" }, remove: ["old"] });
  });

  it("waits for children of an explicit parent or of the calling pane, never both", async () => {
    const { hono, agents } = app();
    expect((await hono.request("/api/terminal/agents/wait-children", post({ caller, mode: "any", timeoutMs: 10_000 }))).status).toBe(200);
    expect(agents.waitChildren).toHaveBeenCalledWith({ workspaceId, tabId }, expect.objectContaining({ mode: "any", timeoutMs: 10_000 }));
    expect((await hono.request("/api/terminal/agents/wait-children", post({ caller, parent: { workspaceId, tabId }, mode: "all" }))).status).toBe(400);
    expect((await hono.request("/api/terminal/agents/wait-children", post({ mode: "all" }))).status).toBe(400);
  });

  it("returns 404 when a report has no parent to go to", async () => {
    const { hono } = app({ agents: { reportToParent: vi.fn(async () => { throw new TerminalAgentVerbError("not_found"); }) } });
    expect((await hono.request("/api/terminal/agents/report", post({ caller, text: "done" }))).status).toBe(404);
  });
});
