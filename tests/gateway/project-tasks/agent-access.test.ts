import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListTasksResponseSchema, TaskResponseSchema } from "@matrix-os/contracts/project-tasks";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { bootstrapProjectTaskDatabase, type ProjectTaskDatabase } from "../../../packages/gateway/src/project-tasks/database.js";
import { ProjectTaskRepository } from "../../../packages/gateway/src/project-tasks/repository.js";
import { ProjectTaskCommentRepository } from "../../../packages/gateway/src/project-tasks/comments.js";
import { ProjectTaskService } from "../../../packages/gateway/src/project-tasks/service.js";
import { ProjectTaskSessionRepository } from "../../../packages/gateway/src/project-tasks/sessions.js";
import { createProjectTaskRoutes } from "../../../packages/gateway/src/project-tasks/routes.js";
import {
  createProjectTaskAgentBindings, createProjectTaskKernelBindings, type ProjectTaskInternalEnv,
} from "../../../packages/gateway/src/server/project-task-agents.js";
import {
  createTaskSessionCredentials, type TaskSessionCredentials,
} from "../../../packages/gateway/src/project-tasks/session-credentials.js";
import { createKernelChatProviderAdapter } from "../../../packages/gateway/src/chat/kernel-provider-adapter.js";
import { tasksCommand } from "../../../packages/sync-client/src/cli/commands/tasks.js";
import { createIntegrationsMcpServer } from "../../../packages/integrations-mcp/src/server.js";
import type { KernelDispatchOverrides } from "../../../packages/gateway/src/dispatcher.js";

const OWNER = { type: "user" as const, id: "user_owner" };
const PROJECTS = [{ id: "proj_alpha", slug: "alpha" }, { id: "proj_beta", slug: "beta" }];
const LOCAL = "c".repeat(64);
const WS_ALPHA = `tws_${"a".repeat(32)}`;
const WS_BETA = `tws_${"b".repeat(32)}`;
const TAB = `tt_${"1".repeat(32)}`;
const OTHER_TAB = `tt_${"2".repeat(32)}`;
const SESSION_ALPHA = `matrix-w-${"a".repeat(32)}`;
const SESSION_BETA = `matrix-w-${"b".repeat(32)}`;

const projects = {
  async getProject(slug: string) {
    const found = PROJECTS.find((project) => project.slug === slug);
    return found ? { ok: true as const, project: { ...found, name: slug } as never } : { ok: false as const, status: 404, error: { code: "not_found", message: "no" } };
  },
  async getProjectById(_owner: unknown, id: string) {
    const found = PROJECTS.find((project) => project.id === id);
    return found ? { ok: true as const, project: found } : { ok: false as const, status: 404 };
  },
};

let db: Kysely<ProjectTaskDatabase>;
let service: ProjectTaskService;
let sessions: ProjectTaskSessionRepository;
let registry: ReturnType<typeof createMatrixMcpCapabilityRegistry>;
let app: Hono;
let credentials: TaskSessionCredentials;
const homes: string[] = [];

async function tempHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.push(home);
  return home;
}

beforeEach(async () => {
  db = new Kysely<ProjectTaskDatabase>({ dialect: (await createTestPGlite()).dialect });
  await bootstrapProjectTaskDatabase(db);
  sessions = new ProjectTaskSessionRepository(db);
  service = new ProjectTaskService({
    repository: new ProjectTaskRepository(db),
    comments: new ProjectTaskCommentRepository(db),
    members: async () => [{ actor: "user:user_owner", name: "Owner", handle: "owner" }],
    projects,
    legacyTasks: { listTasks: async () => ({ ok: true as const, tasks: [], nextCursor: null }) },
    publish: async () => {},
    sessions,
  });
  registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: OWNER.id });
  credentials = createTaskSessionCredentials({ homePath: await tempHome("matrix-task-gateway-") });
  // Production order: gateway auth, then the board routes with the real binding resolver.
  app = new Hono();
  app.use("*", authMiddleware("owner-runtime-token-that-is-long", {
    localTerminalAgentToken: () => LOCAL,
    resolveMatrixMcpRunContext: registry.resolveRunContext,
  }));
  app.route("/", createProjectTaskRoutes({
    service, getOwnerScope: () => OWNER,
    getAgentBinding: createProjectTaskAgentBindings({ projects, credentials }),
    sessionTask: (owner, binding) => sessions.taskForSession(owner.id, binding.projectId, binding.ref),
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  registry.close();
  await db.destroy();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** The gateway as a loopback caller on this machine reaches it. */
function loopback(url: string, init?: RequestInit) {
  return app.request(url, init, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
}

async function ownerTask(slug: string, title: string) {
  const { task } = await service.createTask({ ownerScope: OWNER, actor: "user:user_owner" }, slug, { title, clientRequestId: `req_${title.replace(/\W/g, "_")}` } as never);
  return task;
}

/** A tab the gateway launched for a task: the pane env plus the tab's signed credential. */
async function taskTab(projectId: string, taskId: string, workspaceId = WS_ALPHA, tabId = TAB) {
  return credentials.issue({ workspaceId, tabId, projectId, taskId });
}

async function inPane(sessionName: string, sessionToken?: string) {
  const home = await tempHome("matrix-task-pane-");
  await mkdir(join(home, ".cache", "matrix"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, ".cache", "matrix", "terminal-agent.token"), `${LOCAL}\n`, { mode: 0o600 });
  await chmod(join(home, ".cache", "matrix", "terminal-agent.token"), 0o600);
  vi.stubEnv("HOME", home);
  vi.stubEnv("MATRIX_HOME", home);
  vi.stubEnv("ZELLIJ_SESSION_NAME", sessionName);
  vi.stubEnv("ZELLIJ_PANE_ID", "3");
  vi.stubEnv("PORT", "4000");
  vi.stubEnv("MATRIX_TASK_SESSION_TOKEN", sessionToken ?? "");
  const fetch = vi.fn((url: string, init: RequestInit) => loopback(url, init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function cli(name: string, args: Record<string, unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => { out.push(String(line)); });
  vi.spyOn(console, "error").mockImplementation((line?: unknown) => { err.push(String(line)); });
  const command = tasksCommand.subCommands![name as keyof typeof tasksCommand.subCommands] as unknown as { run: (input: unknown) => Promise<void> };
  // No --token, --profile or --dev: the CLI picks the pane's local token itself.
  await command.run({ args: { json: true, _: [], ...args }, rawArgs: [] });
  return { out: out.map((line) => JSON.parse(line)), err };
}

// Fault detected: inside a Matrix pane `matrix tasks` used the local terminal token, which
// the gateway accepted only on terminal-agent routes, so every task command was refused.
describe("matrix tasks from a task terminal tab", () => {
  it("works with the local token and the tab's credential, bounded to the tab's project, acting as the tab", async () => {
    const seed = await ownerTask("alpha", "Seed");
    await inPane(SESSION_ALPHA, await taskTab("proj_alpha", seed.id));
    await ownerTask("beta", "Secret");
    const created = await cli("create", { first: "From the pane" });
    expect(created.out[0]).toMatchObject({ ok: true, data: { task: { title: "From the pane", createdBy: `agent:term.${WS_ALPHA}.${TAB}` } } });

    const listed = await cli("list", {});
    expect(listed.out[0].data.tasks.map((task: { title: string }) => task.title).sort()).toEqual(["From the pane", "Seed"]);

    const other = await cli("list", { project: "beta" });
    expect(other.out[0]).toMatchObject({ error: { code: "project_out_of_scope" } });
  });

  it("is refused by the gateway for another project, owner-only routes and a forged credential", async () => {
    const beta = await ownerTask("beta", "Secret");
    const token = await taskTab("proj_alpha", "task_alpha");
    const headers = { Authorization: `Bearer ${LOCAL}`, "x-matrix-task-session-token": token };
    expect((await loopback("http://127.0.0.1:4000/api/projects/alpha/tasks", { headers })).status).toBe(200);
    expect((await loopback("http://127.0.0.1:4000/api/projects/beta/tasks", { headers })).status).toBe(403);
    expect((await loopback(`http://127.0.0.1:4000/api/projects/beta/tasks/${beta.id}`, { headers })).status).toBe(403);
    // Delete and settings stay owner-only for the local token.
    expect((await loopback(`http://127.0.0.1:4000/api/projects/alpha/tasks/${beta.id}`, { method: "DELETE", headers })).status).toBe(401);
    expect((await loopback("http://127.0.0.1:4000/api/projects/alpha/board/settings", { headers })).status).toBe(401);
    // A credential edited to another project, or signed by another owner's secret, reaches no board.
    const edited = { ...headers, "x-matrix-task-session-token": token.replace("proj_alpha", "proj_beta") };
    expect((await loopback("http://127.0.0.1:4000/api/projects/beta/tasks", { headers: edited })).status).toBe(403);
    const foreign = await createTaskSessionCredentials({ homePath: await tempHome("matrix-task-foreign-") })
      .issue({ workspaceId: WS_BETA, tabId: TAB, projectId: "proj_beta", taskId: "task_beta" });
    expect((await loopback("http://127.0.0.1:4000/api/projects/beta/tasks", { headers: { ...headers, "x-matrix-task-session-token": foreign } })).status).toBe(403);
    // From outside this machine the local token is not accepted at all.
    expect((await app.request("http://127.0.0.1:4000/api/projects/alpha/tasks", { headers }, { incoming: { socket: { remoteAddress: "10.0.0.5" } } })).status).toBe(401);
  });

  // Fault detected: the binding came from caller-named pane headers, so any agent holding the
  // shared local token could name another live pane and act on that pane's board as that pane.
  it("refuses a caller holding the shared local token that names another pane", async () => {
    await ownerTask("beta", "Secret");
    const paneHeaders = { "x-matrix-terminal-session": SESSION_BETA, "x-matrix-terminal-pane": "3" };
    const named = { Authorization: `Bearer ${LOCAL}`, ...paneHeaders };
    expect((await loopback("http://127.0.0.1:4000/api/projects/beta/tasks", { headers: named })).status).toBe(403);
    expect((await loopback("http://127.0.0.1:4000/api/projects/beta/tasks", { method: "POST", headers: { ...named, "content-type": "application/json" }, body: JSON.stringify({ title: "x", clientRequestId: "req_x" }) })).status).toBe(403);
    // Its own alpha credential does not become the beta pane by naming it either.
    const own = { ...named, "x-matrix-task-session-token": await taskTab("proj_alpha", "task_alpha", WS_ALPHA, OTHER_TAB) };
    expect((await loopback("http://127.0.0.1:4000/api/projects/beta/tasks", { headers: own })).status).toBe(403);
    const created = await loopback("http://127.0.0.1:4000/api/projects/alpha/tasks", {
      method: "POST", headers: { ...own, "content-type": "application/json" }, body: JSON.stringify({ title: "Mine", clientRequestId: "req_mine" }),
    });
    expect(TaskResponseSchema.parse(await created.json()).task.createdBy).toBe(`agent:term.${WS_ALPHA}.${OTHER_TAB}`);
  });

  it("does not use the local token in a terminal the gateway did not launch for a task", async () => {
    const fetch = await inPane(SESSION_ALPHA);
    const result = await cli("list", { project: "alpha" });
    expect(result.out[0].ok).not.toBe(true);
    for (const [, init] of fetch.mock.calls) {
      expect(JSON.stringify(init?.headers ?? {})).not.toContain(LOCAL);
    }
  });

  it("tells a tab whose credential the gateway refuses that it has no board", async () => {
    const foreign = await createTaskSessionCredentials({ homePath: await tempHome("matrix-task-foreign-") })
      .issue({ workspaceId: WS_ALPHA, tabId: TAB, projectId: "proj_alpha", taskId: "task_alpha" });
    await inPane(SESSION_ALPHA, foreign);
    const result = await cli("list", { project: "alpha" });
    expect(result.out[0]).toMatchObject({ error: { code: "terminal_unbound" } });
  });
});

async function mcp(token: string, surface: "chat-call" | "chat-discovery") {
  vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", token);
  const server = createIntegrationsMcpServer({ toolSurface: surface, fetcher: (url, init) => loopback(url, init) });
  const client = new Client({ name: "chat-run", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
}

// Fault detected: a chat run's MCP child holds only its run token, whose gateway allowlist
// covered integrations and Custom MCP, so every board tool was refused.
describe("board tools in a chat run", () => {
  it("reach the run's own project with the run token, acting as the chat", async () => {
    const task = await ownerTask("alpha", "Board task");
    await sessions.link({ ownerId: OWNER.id, projectId: "proj_alpha" }, task.id, { ref: "chat_abc", kind: "chat", title: "AL-1" }, "user:user_owner", "session_started");
    const capability = registry.issue({ owner: { type: "personal", ownerId: OWNER.id }, runId: "run_1", scope: "chat_call", board: { chatId: "chat_abc", projectSlug: "alpha" } })!;
    const { client, close } = await mcp(capability.token, "chat-call");
    try {
      // The run's task is the default: the gateway reports it from the task session link.
      expect(text(await client.callTool({ name: "project_task_comment", arguments: { body: "PR is up" } }))).toContain("tcm_");
      const created = await client.callTool({ name: "project_task_create", arguments: { title: "Follow-up", clientRequestId: "req_follow_up" } });
      expect(created.isError).not.toBe(true);
      const tasks = ListTasksResponseSchema.parse(await (await loopback("http://127.0.0.1:4000/api/projects/alpha/tasks", { headers: { Authorization: "Bearer owner-runtime-token-that-is-long" } })).json()).tasks;
      expect(tasks.find((entry) => entry.title === "Follow-up")?.createdBy).toBe("agent:chat_abc");
      const refused = await client.callTool({ name: "project_task_list", arguments: { project: "beta" } });
      expect(refused.isError).toBe(true);
    } finally { await close(); }
    // The token itself never reaches another project or an owner-only route.
    const headers = { Authorization: `Bearer ${capability.token}` };
    expect((await loopback("http://127.0.0.1:4000/api/projects/beta/tasks", { headers })).status).toBe(401);
    expect((await loopback(`http://127.0.0.1:4000/api/projects/alpha/tasks/${task.id}/archive`, { method: "POST", headers })).status).toBe(401);
  });

  it("only reads on a discovery run and has no board without a project", async () => {
    const discovery = registry.issue({ owner: { type: "personal", ownerId: OWNER.id }, runId: "run_2", scope: "chat_discovery", board: { chatId: "chat_def", projectSlug: "alpha" } })!;
    const headers = { Authorization: `Bearer ${discovery.token}`, "content-type": "application/json" };
    expect((await loopback("http://127.0.0.1:4000/api/projects/alpha/tasks", { headers })).status).toBe(200);
    expect((await loopback("http://127.0.0.1:4000/api/projects/alpha/tasks", { method: "POST", headers, body: JSON.stringify({ title: "x", clientRequestId: "req_x" }) })).status).toBe(401);

    const unbound = registry.issue({ owner: { type: "personal", ownerId: OWNER.id }, runId: "run_3", scope: "chat_call" })!;
    const { client, close } = await mcp(unbound.token, "chat-call");
    try {
      const result = await client.callTool({ name: "project_task_list", arguments: { project: "alpha" } });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/not authorized/i);
    } finally { await close(); }
    expect(registry.issue({ owner: { type: "personal", ownerId: OWNER.id }, runId: "run_4", scope: "call", board: { chatId: "chat_x", projectSlug: "alpha" } })).toBeNull();
  });
});

// Fault detected: no production caller built the kernel binding, so kernel runs never had
// board tools, even in a chat started from a board task.
describe("board tools in a kernel chat run", () => {
  function kernelBindings() {
    const internal = createProjectTaskRoutes({
      service, sessionTask: (owner, binding) => sessions.taskForSession(owner.id, binding.projectId, binding.ref),
      getOwnerScope: (c) => (c.env as ProjectTaskInternalEnv).projectTaskAgent.ownerScope,
      getAgentBinding: async (c) => (c.env as ProjectTaskInternalEnv).projectTaskAgent.binding,
    });
    return createProjectTaskKernelBindings({ routes: internal, projects, sessions });
  }

  it("binds a board-started chat to its task and project and acts as the chat", async () => {
    const task = await ownerTask("alpha", "Started from the board");
    await sessions.link({ ownerId: OWNER.id, projectId: "proj_alpha" }, task.id, { ref: "chat_kernel", kind: "chat", title: "AL-1" }, "user:user_owner", "session_started");
    const overrides: KernelDispatchOverrides[] = [];
    const adapter = createKernelChatProviderAdapter({
      dispatcher: { dispatch: vi.fn(async (_prompt, _session, onEvent, _meta, _controller, override) => {
        overrides.push(override!);
        onEvent({ type: "result", data: { tokensIn: 1, tokensOut: 1 } } as never);
      }) } as never,
      projectTasks: kernelBindings(),
    });
    const events = adapter.start({
      owner: { type: "personal", ownerId: OWNER.id }, chatId: "chat_kernel", turnId: "turn_1", runId: "run_1",
      prompt: "work", parts: [{ type: "text", text: "work" }], selection: { instanceId: "kernel_owner_anthropic_key", model: "claude-sonnet-5" },
      interactionMode: "default", permissionMode: "full_access", projectSlug: "alpha", signal: new AbortController().signal,
    } as never);
    for await (const _event of events) { /* drain */ }
    const binding = overrides[0]!.projectTasks!;
    expect(binding.session).toEqual({ projectId: "proj_alpha", projectSlug: "alpha", taskId: task.id });

    const comment = await binding.client.createComment("alpha", task.id, { body: "Kernel note" });
    expect(comment.author).toBe("agent:chat_kernel");
    await expect(binding.client.listTasks("beta")).rejects.toMatchObject({ code: "task_forbidden" });
    const read = TaskResponseSchema.parse({ task: await binding.client.getTask("alpha", task.id) }).task;
    expect(read.commentCount).toBe(1);
  });

  it("gives a run outside any project no binding", async () => {
    const bindings = kernelBindings();
    await expect(bindings({ owner: { type: "personal", ownerId: OWNER.id }, chatId: "chat_x" })).resolves.toBeNull();
    await expect(bindings({ owner: { type: "personal", ownerId: OWNER.id }, chatId: "chat_x", projectSlug: "missing" })).resolves.toBeNull();
  });
});
