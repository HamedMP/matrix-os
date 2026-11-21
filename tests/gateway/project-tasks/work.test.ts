import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { Hono } from "hono";
import {
  AttachableSessionsResponseSchema, ProjectTaskErrorSchema, StartTaskResponseSchema, TaskGitResponseSchema, TaskPullRequestResponseSchema,
  TaskResponseSchema, type ProjectTask, type TaskAgentStatus, type TaskPullRequest,
} from "@matrix-os/contracts/project-tasks";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { bootstrapProjectTaskDatabase, type ProjectTaskDatabase } from "../../../packages/gateway/src/project-tasks/database.js";
import { ProjectTaskRepository } from "../../../packages/gateway/src/project-tasks/repository.js";
import { ProjectTaskCommentRepository } from "../../../packages/gateway/src/project-tasks/comments.js";
import { ProjectTaskService } from "../../../packages/gateway/src/project-tasks/service.js";
import { ProjectTaskSessionRepository } from "../../../packages/gateway/src/project-tasks/sessions.js";
import { ProjectTaskWork, taskBranchName } from "../../../packages/gateway/src/project-tasks/work.js";
import { PullRequestCache } from "../../../packages/gateway/src/project-tasks/pr-cache.js";
import { createProjectTaskRoutes } from "../../../packages/gateway/src/project-tasks/routes.js";
import type { PullRequestLookup, TaskSessionPorts } from "../../../packages/gateway/src/project-tasks/session-ports.js";
import { ProjectFenceError } from "../../../packages/gateway/src/collaboration/project-fence.js";

const OWNER = { type: "user" as const, id: "user_owner" };
const PROJECT = { id: "proj_demo", slug: "board-demo", defaultBranch: "main" };
const WS = `tws_${"a".repeat(32)}`;
const SELECTION = { instanceId: "claude", model: "claude-opus-5" };

/** In-memory ports that record what start work asked of each subsystem. */
function fakePorts() {
  const state = {
    git: true,
    worktrees: new Map<string, { id: string; path: string; branch: string }>(),
    chats: new Map<string, { id: string; title: string; projectId: string | null; requestId: string; defaultWorktreeId?: string }>(),
    tabs: new Map<string, { workspaceId: string; tabId: string; name: string; cwd: string; env: Record<string, string> }>(),
    turns: [] as Array<{ chatId: string; clientRequestId: string; text: string; executionRoot: unknown }>,
    statuses: {} as Record<string, TaskAgentStatus>,
    pr: { status: "ok", pullRequest: null } as PullRequestLookup,
    prCalls: 0,
    opened: [] as Array<{ branch: string; title: string }>,
    failChatCreate: 0,
    failLinkOnce: false,
  };
  const ports: TaskSessionPorts = {
    projectRoot: { resolve: async () => ({ path: "/home/owner/projects/board-demo/repo", git: state.git }) },
    worktrees: {
      async ensure({ branch }) {
        const id = `wt_${Buffer.from(branch).toString("hex").slice(0, 16)}`;
        const record = state.worktrees.get(id) ?? { id, path: `/home/owner/worktrees/board-demo/${id}`, branch };
        state.worktrees.set(id, record);
        return record;
      },
      async get({ worktreeId }) { return state.worktrees.get(worktreeId) ?? null; },
    },
    git: { summary: async () => ({ branch: null, dirty: true, ahead: 2, behind: 1, changedFiles: 3 }) },
    chats: {
      async create(_owner, input) {
        if (state.failChatCreate > 0) { state.failChatCreate -= 1; throw new Error("chat store down"); }
        const existing = [...state.chats.values()].find((chat) => chat.requestId === input.clientRequestId);
        if (existing) return { id: existing.id, revision: 0 };
        const id = `chat_${state.chats.size + 1}`;
        state.chats.set(id, {
          id, title: input.title, projectId: input.projectId, requestId: input.clientRequestId,
          ...(input.worktreeId ? { defaultWorktreeId: input.worktreeId } : {}),
        });
        return { id, revision: 0 };
      },
      async admitFirstTurn(input) { state.turns.push(input); },
      async describe(_owner, ids) {
        return ids.flatMap((id) => {
          const chat = state.chats.get(id);
          return chat ? [{ id: chat.id, title: chat.title, projectId: chat.projectId }] : [];
        });
      },
      async listForProject(_owner, projectId) { return [...state.chats.values()].filter((chat) => chat.projectId === projectId); },
      async statuses(_owner, ids) { return Object.fromEntries(ids.filter((id) => state.statuses[id]).map((id) => [id, state.statuses[id]!])); },
    },
    terminals: {
      async ensureWorkspace() { return { workspaceId: WS }; },
      async createTab(input) {
        state.tabs.set(input.tabId, { ...input, env: { ...input.env } });
        return { tabId: input.tabId };
      },
      async listForProject() { return [...state.tabs.values()].map(({ workspaceId, tabId, name }) => ({ workspaceId, tabId, name })); },
      async existingRefs() { return [...state.tabs.values()].map(({ workspaceId, tabId }) => `term.${workspaceId}.${tabId}`); },
      async statuses() { return { ...state.statuses }; },
    },
    pullRequests: {
      async find() { state.prCalls += 1; return state.pr; },
      async open(input) {
        state.opened.push({ branch: input.branch, title: input.title });
        return state.pr;
      },
    },
  };
  return { state, ports };
}

describe("project task start work, sessions and pull requests", () => {
  let db: Kysely<ProjectTaskDatabase>;
  let app: Hono;
  let fake: ReturnType<typeof fakePorts>;
  let sessions: ProjectTaskSessionRepository;
  let clock = 0;
  let fenceClosed = false;
  const fenced: string[] = [];

  async function build() {
    db = new Kysely<ProjectTaskDatabase>({ dialect: (await createTestPGlite()).dialect });
    await bootstrapProjectTaskDatabase(db);
    fake = fakePorts();
    sessions = new ProjectTaskSessionRepository(db);
    const realLink = sessions.link.bind(sessions);
    sessions.link = async (...args) => {
      if (fake.state.failLinkOnce) { fake.state.failLinkOnce = false; throw new Error("connection reset"); }
      return realLink(...args);
    };
    const tasks = new ProjectTaskService({
      repository: new ProjectTaskRepository(db),
      comments: new ProjectTaskCommentRepository(db),
      members: async () => [],
      projects: { getProject: async (slug: string) => (slug === PROJECT.slug
        ? { ok: true as const, project: { ...PROJECT, name: "Board demo", kind: "github" } as never }
        : { ok: false as const, status: 404, error: { code: "not_found", message: "Project was not found" } }) },
      legacyTasks: { listTasks: async () => ({ ok: true as const, tasks: [], nextCursor: null }) },
      publish: async () => {},
      sessions,
      agentStatus: { chats: fake.ports.chats, terminals: fake.ports.terminals },
    });
    clock = 1_000_000;
    const work = new ProjectTaskWork({ tasks, sessions, ports: fake.ports, cache: new PullRequestCache(500, 60_000, () => clock) });
    app = new Hono();
    fenceClosed = false;
    fenced.length = 0;
    app.route("/", createProjectTaskRoutes({
      service: tasks, work, getOwnerScope: () => OWNER, getPrincipal: () => ({ userId: OWNER.id, source: "jwt" }) as never,
      projectOperationAdmission: {
        async withLegacyAdmission(input, operation) {
          if (fenceClosed) { fenced.push(input.projectId); throw new ProjectFenceError("fenced"); }
          return operation();
        },
      },
    }));
  }

  function call(method: string, path: string, body?: unknown) {
    return app.request(`/api/projects/${PROJECT.slug}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  async function create(title: string, extra: Record<string, unknown> = {}): Promise<ProjectTask> {
    const response = await call("POST", "/tasks", { title, clientRequestId: `req_${title.replace(/\W/g, "_")}`, ...extra });
    return TaskResponseSchema.parse(await response.json()).task;
  }

  async function start(task: ProjectTask, body: Record<string, unknown>) {
    const response = await call("POST", `/tasks/${task.id}/start`, body);
    return { status: response.status, body: await response.json() as unknown };
  }

  async function get(task: ProjectTask): Promise<ProjectTask> {
    return TaskResponseSchema.parse(await (await call("GET", `/tasks/${task.id}`)).json()).task;
  }

  async function activity(task: ProjectTask): Promise<Array<{ kind: string; actor: string; summary: string }>> {
    return ((await (await call("GET", `/tasks/${task.id}/activity`)).json()) as { activity: Array<{ kind: string; actor: string; summary: string }> }).activity;
  }

  beforeEach(async () => { await build(); });
  afterEach(async () => { await db.destroy(); });

  it("builds a bounded, safe branch name from the key and title", () => {
    expect(taskBranchName("BD-7", "Fix: the login  bug!")).toBe("task/bd-7-fix-the-login-bug");
    const long = taskBranchName("BD-7", "x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(taskBranchName("BD-7", "日本語")).toBe("task/bd-7");
  });

  it("starts a chat in a new worktree, records it, moves the card and returns the first message without a selection", async () => {
    const task = await create("Fix login", { status: "todo", description: "Users get logged out." });
    const result = await start(task, { kind: "chat", message: "Start with the cookie code.", clientRequestId: "req_start1" });
    expect(result.status).toBe(201);
    const body = StartTaskResponseSchema.parse(result.body);
    expect(body.session).toMatchObject({ kind: "chat", role: "main", agentStatus: "idle", title: "BD-1 Fix login" });
    expect(body.task).toMatchObject({ status: "in_progress", branch: "task/bd-1-fix-login" });
    expect(body.task.worktreeId).toMatch(/^wt_/);
    expect(body.task.sessions.map((session) => session.ref)).toEqual([body.session.ref]);
    expect(body.firstMessage).toBe("BD-1: Fix login\n\nUsers get logged out.\n\nStart with the cookie code.");
    expect(fake.state.turns).toEqual([]);
    expect([...fake.state.chats.values()][0]).toMatchObject({ projectId: PROJECT.id });
    const log = await activity(task);
    expect(log.map((entry) => entry.kind)).toEqual(["created", "session_started", "moved"]);
    expect(log.at(-1)).toMatchObject({ actor: "system:automation", summary: "To do → In progress" });
  });

  it("admits the first chat turn in the worktree when a model is selected", async () => {
    const task = await create("With model");
    const body = StartTaskResponseSchema.parse((await start(task, { kind: "chat", selection: SELECTION, clientRequestId: "req_model" })).body);
    expect(body.firstMessage).toBeUndefined();
    expect(fake.state.turns).toHaveLength(1);
    expect(fake.state.turns[0]).toMatchObject({
      chatId: body.session.ref, text: "BD-1: With model",
      executionRoot: { kind: "worktree", projectId: PROJECT.id, worktreeId: body.task.worktreeId },
    });
  });

  it("starts a terminal tab in the worktree with the task environment and a harness", async () => {
    const task = await create("Terminal task");
    const body = StartTaskResponseSchema.parse((await start(task, { kind: "terminal", harness: "codex", clientRequestId: "req_term" })).body);
    expect(body.session.ref).toMatch(/^term\.tws_[a-f0-9]{32}\.tt_[a-f0-9]{32}$/);
    expect(body.session).toMatchObject({ kind: "terminal", harness: "codex", role: "main" });
    const [tab] = [...fake.state.tabs.values()];
    expect(tab?.cwd).toBe(fake.state.worktrees.get(body.task.worktreeId!)?.path);
    expect(tab?.env).toEqual({ MATRIX_TASK_ID: task.id, MATRIX_PROJECT_ID: PROJECT.id });
    expect(body.firstMessage).toBe("BD-1: Terminal task");
    expect((await start(task, { kind: "terminal", harness: "rm-rf", clientRequestId: "req_bad" })).status).toBe(400);
  });

  it("runs in the project folder for a project that is not a git repository", async () => {
    fake.state.git = false;
    const task = await create("Scratch");
    const body = StartTaskResponseSchema.parse((await start(task, { kind: "terminal", clientRequestId: "req_scratch" })).body);
    expect(body.task.worktreeId).toBeNull();
    expect(body.task.branch).toBeNull();
    expect([...fake.state.tabs.values()][0]?.cwd).toBe("/home/owner/projects/board-demo/repo");
  });

  it("resumes a start that failed between steps without duplicating the worktree, chat or link", async () => {
    const task = await create("Flaky");
    fake.state.failChatCreate = 1;
    const failed = await start(task, { kind: "chat", clientRequestId: "req_retry" });
    expect(failed.status).toBe(503);
    expect(ProjectTaskErrorSchema.parse(failed.body).error.code).toBe("task_session_unavailable");
    const afterFailure = await get(task);
    expect(afterFailure.worktreeId).toMatch(/^wt_/);
    expect(afterFailure.sessions).toEqual([]);

    fake.state.failLinkOnce = true;
    expect((await start(task, { kind: "chat", clientRequestId: "req_retry" })).status).toBe(503);
    expect(fake.state.chats.size).toBe(1);

    const resumed = StartTaskResponseSchema.parse((await start(task, { kind: "chat", clientRequestId: "req_retry" })).body);
    const again = StartTaskResponseSchema.parse((await start(task, { kind: "chat", clientRequestId: "req_retry" })).body);
    expect(again.session.ref).toBe(resumed.session.ref);
    expect(fake.state.chats.size).toBe(1);
    expect(fake.state.worktrees.size).toBe(1);
    expect(again.task.worktreeId).toBe(afterFailure.worktreeId);
    expect(again.task.sessions).toHaveLength(1);
    expect((await activity(task)).filter((entry) => entry.kind === "session_started")).toHaveLength(1);
  });

  it("adds extra sessions to the same worktree and stops at 16", async () => {
    const task = await create("Busy");
    const first = StartTaskResponseSchema.parse((await start(task, { kind: "chat", clientRequestId: "req_s0" })).body);
    for (let index = 1; index < 16; index += 1) {
      expect((await start(task, { kind: "terminal", clientRequestId: `req_s${index}` })).status).toBe(201);
    }
    const full = await get(task);
    expect(full.sessions).toHaveLength(16);
    expect(full.sessions.filter((session) => session.role === "main").map((session) => session.ref)).toEqual([first.session.ref]);
    expect(new Set([...fake.state.tabs.values()].map((tab) => tab.cwd))).toEqual(new Set([fake.state.worktrees.get(full.worktreeId!)?.path]));
    const over = await start(task, { kind: "terminal", clientRequestId: "req_s16" });
    expect(over.status).toBe(409);
    expect(ProjectTaskErrorSchema.parse(over.body).error.code).toBe("task_limit_reached");
    expect(fake.state.tabs.size).toBe(15);
  });

  it("attaches only existing, unbound sessions of this project and detaches them, promoting the next main", async () => {
    const a = await create("A");
    const b = await create("B");
    const started = StartTaskResponseSchema.parse((await start(a, { kind: "chat", clientRequestId: "req_a" })).body);
    fake.state.chats.set("chat_free", { id: "chat_free", title: "Loose chat", projectId: PROJECT.id, requestId: "x" });
    fake.state.chats.set("chat_other", { id: "chat_other", title: "Elsewhere", projectId: "proj_other", requestId: "y" });

    const attachable = AttachableSessionsResponseSchema.parse(await (await call("GET", "/board/attachable-sessions")).json());
    expect(attachable.sessions.map((session) => session.ref)).toEqual(["chat_free"]);

    const attached = TaskResponseSchema.parse(await (await call("POST", `/tasks/${a.id}/sessions`, { ref: "chat_free" })).json()).task;
    expect(attached.sessions.map((session) => [session.ref, session.role])).toEqual([[started.session.ref, "main"], ["chat_free", "extra"]]);

    const taken = await call("POST", `/tasks/${b.id}/sessions`, { ref: "chat_free" });
    expect(taken.status).toBe(409);
    expect(ProjectTaskErrorSchema.parse(await taken.json()).error.code).toBe("task_session_taken");
    expect((await call("POST", `/tasks/${b.id}/sessions`, { ref: "chat_other" })).status).toBe(404);
    expect((await call("POST", `/tasks/${b.id}/sessions`, { ref: "chat_missing" })).status).toBe(404);
    expect((await call("POST", `/tasks/${b.id}/sessions`, { ref: "../etc" })).status).toBe(400);

    const detached = TaskResponseSchema.parse(await (await call("DELETE", `/tasks/${a.id}/sessions/${started.session.ref}`)).json()).task;
    expect(detached.sessions.map((session) => [session.ref, session.role])).toEqual([["chat_free", "main"]]);
    expect((await call("DELETE", `/tasks/${a.id}/sessions/${started.session.ref}`)).status).toBe(404);
    expect((await activity(a)).map((entry) => entry.kind)).toContain("session_detached");
    expect(fake.state.chats.has(started.session.ref)).toBe(true);
  });

  it("refuses to close a task while its agent works unless forced, and keeps the sessions", async () => {
    const task = await create("Closing", { status: "in_progress" });
    const started = StartTaskResponseSchema.parse((await start(task, { kind: "chat", clientRequestId: "req_close" })).body);
    fake.state.statuses[started.session.ref] = "working";
    expect((await get(task)).sessions[0]?.agentStatus).toBe("working");
    const refused = await call("POST", `/tasks/${task.id}/move`, { status: "done" });
    expect(refused.status).toBe(409);
    expect(ProjectTaskErrorSchema.parse(await refused.json()).error.code).toBe("task_agent_working");
    expect((await call("POST", `/tasks/${task.id}/move`, { status: "in_review" })).status).toBe(200);
    const forced = await call("POST", `/tasks/${task.id}/move`, { status: "canceled", force: true });
    expect(forced.status).toBe(200);
    const closed = TaskResponseSchema.parse(await forced.json()).task;
    expect(closed).toMatchObject({ status: "canceled", worktreeId: started.task.worktreeId, branch: started.task.branch });
    expect(closed.sessions).toHaveLength(1);
    fake.state.statuses[started.session.ref] = "done";
    expect((await call("POST", `/tasks/${task.id}/move`, { status: "done" })).status).toBe(200);
  });

  it("reports git state, stores the PR summary and moves forward only on PR transitions", async () => {
    const task = await create("Ship it", { status: "todo" });
    await start(task, { kind: "chat", clientRequestId: "req_ship" });
    const pr = (state: TaskPullRequest["state"]): PullRequestLookup => ({
      status: "ok", pullRequest: { number: 12, url: "https://github.com/o/r/pull/12", state, checks: "pending", review: "review_required" },
    });

    fake.state.pr = pr("open");
    const git = TaskGitResponseSchema.parse(await (await call("GET", `/tasks/${task.id}/git`)).json()).git;
    expect(git).toMatchObject({ branch: "task/bd-1-ship-it", dirty: true, ahead: 2, behind: 1, changedFiles: 3, prStatus: "ok" });
    expect(git.pullRequest?.number).toBe(12);
    let current = await get(task);
    expect(current).toMatchObject({ status: "in_review", pullRequest: { number: 12, state: "open" } });

    // A person moves it back; the same open PR does not move it again.
    await call("POST", `/tasks/${task.id}/move`, { status: "in_progress" });
    await call("GET", `/tasks/${task.id}/git`);
    expect(fake.state.prCalls).toBe(1);
    clock += 61_000;
    fake.state.pr = { status: "ok", pullRequest: { ...(pr("open") as { pullRequest: TaskPullRequest }).pullRequest, checks: "passing" } };
    await call("GET", `/tasks/${task.id}/git`);
    expect(fake.state.prCalls).toBe(2);
    expect(await get(task)).toMatchObject({ status: "in_progress", pullRequest: { checks: "passing" } });

    // A task someone canceled never comes back on merge.
    await call("POST", `/tasks/${task.id}/move`, { status: "canceled", force: true });
    fake.state.pr = pr("merged");
    clock += 61_000;
    await call("GET", `/tasks/${task.id}/git`);
    current = await get(task);
    expect(current.status).toBe("canceled");
    const kinds = (await activity(task)).map((entry) => `${entry.kind}:${entry.actor}`);
    expect(kinds.filter((kind) => kind.startsWith("pr_opened"))).toHaveLength(1);
  });

  it("moves a merged PR's task to done and opens a PR through the port", async () => {
    const task = await create("Merge me", { status: "in_progress" });
    await start(task, { kind: "terminal", clientRequestId: "req_merge" });
    fake.state.pr = { status: "ok", pullRequest: { number: 5, url: "https://github.com/o/r/pull/5", state: "open", checks: "passing", review: "approved" } };
    const opened = TaskPullRequestResponseSchema.parse(await (await call("POST", `/tasks/${task.id}/pull-request`, {})).json());
    expect(fake.state.opened).toEqual([{ branch: "task/bd-1-merge-me", title: "BD-1: Merge me" }]);
    expect(opened.task).toMatchObject({ status: "in_review", pullRequest: { number: 5 } });
    fake.state.pr = { status: "ok", pullRequest: { number: 5, url: "https://github.com/o/r/pull/5", state: "merged", checks: "passing", review: "approved" } };
    expect((await call("GET", `/tasks/${task.id}/git`)).status).toBe(200);
    // Cached for 60 s: the opened PR is what the cache holds until it expires.
    expect((await get(task)).status).toBe("in_review");
    clock += 61_000;
    expect((await call("GET", `/tasks/${task.id}/git`)).status).toBe(200);
    expect((await get(task))).toMatchObject({ status: "done", pullRequest: { state: "merged" } });
    const log = await activity(task);
    expect(log.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["pr_opened", "pr_merged"]));
    expect(log.at(-1)).toMatchObject({ kind: "moved", actor: "system:automation", summary: "In review → Done" });
  });

  it("answers prStatus unavailable, not an error, when gh is missing or signed out", async () => {
    const task = await create("No gh");
    await start(task, { kind: "chat", clientRequestId: "req_nogh" });
    fake.state.pr = { status: "unavailable" };
    const response = await call("GET", `/tasks/${task.id}/git`);
    expect(response.status).toBe(200);
    const git = TaskGitResponseSchema.parse(await response.json()).git;
    expect(git).toMatchObject({ prStatus: "unavailable", pullRequest: null, branch: "task/bd-1-no-gh" });
    const pr = await call("POST", `/tasks/${task.id}/pull-request`, {});
    expect(pr.status).toBe(200);
    expect(TaskPullRequestResponseSchema.parse(await pr.json()).git.prStatus).toBe("unavailable");
  });

  it("refuses a pull request for a task without a branch and validates bodies", async () => {
    const task = await create("No branch");
    expect((await call("POST", `/tasks/${task.id}/pull-request`, {})).status).toBe(400);
    expect((await call("POST", `/tasks/${task.id}/start`, { kind: "chat", branch: "evil" })).status).toBe(400);
    expect((await call("POST", `/tasks/${task.id}/start`, { kind: "chat", clientRequestId: "nope" })).status).toBe(400);
  });

  it("keeps the task worktree as the chat's default root when no model is selected", async () => {
    const task = await create("Composer later");
    const body = StartTaskResponseSchema.parse((await start(task, { kind: "chat", clientRequestId: "req_composer" })).body);
    expect(fake.state.turns).toEqual([]);
    expect(fake.state.chats.get(body.session.ref)).toMatchObject({ projectId: PROJECT.id, defaultWorktreeId: body.task.worktreeId });
  });

  it("refreshes the PR after 60 s even when the board keeps reading it", async () => {
    const task = await create("Busy reader");
    await start(task, { kind: "terminal", clientRequestId: "req_reader" });
    fake.state.pr = { status: "ok", pullRequest: { number: 3, url: "https://github.com/o/r/pull/3", state: "open", checks: "pending", review: "none" } };
    await call("GET", `/tasks/${task.id}/git`);
    expect(fake.state.prCalls).toBe(1);
    clock += 40_000;
    await call("GET", `/tasks/${task.id}/git`);
    expect(fake.state.prCalls).toBe(1);
    clock += 30_000;
    await call("GET", `/tasks/${task.id}/git`);
    expect(fake.state.prCalls).toBe(2);
  });

  it("serves git state but skips storing the PR and automation when the project fence rejects writes", async () => {
    const task = await create("Fenced", { status: "in_progress" });
    await start(task, { kind: "terminal", clientRequestId: "req_fenced" });
    fake.state.pr = { status: "ok", pullRequest: { number: 9, url: "https://github.com/o/r/pull/9", state: "open", checks: "passing", review: "none" } };
    fenceClosed = true;
    const response = await call("GET", `/tasks/${task.id}/git`);
    expect(response.status).toBe(200);
    expect(TaskGitResponseSchema.parse(await response.json()).git).toMatchObject({ prStatus: "ok", pullRequest: { number: 9 } });
    expect(fenced).toEqual([PROJECT.id]);
    fenceClosed = false;
    expect(await get(task)).toMatchObject({ status: "in_progress", pullRequest: null });
    clock += 61_000;
    await call("GET", `/tasks/${task.id}/git`);
    expect(await get(task)).toMatchObject({ status: "in_review", pullRequest: { number: 9 } });
  });

  it("marks deleted chats and closed tabs unavailable and does not count them toward the session limit", async () => {
    const task = await create("Stale");
    const chat = StartTaskResponseSchema.parse((await start(task, { kind: "chat", clientRequestId: "req_stale_chat" })).body);
    const tab = StartTaskResponseSchema.parse((await start(task, { kind: "terminal", clientRequestId: "req_stale_tab" })).body);
    expect((await get(task)).sessions.map((session) => session.unavailable)).toEqual([undefined, undefined]);

    fake.state.chats.delete(chat.session.ref);
    fake.state.tabs.delete(tab.session.ref.split(".")[2]!);
    const stale = await get(task);
    expect(stale.sessions.map((session) => [session.ref, session.unavailable, session.agentStatus])).toEqual([
      [chat.session.ref, true, "idle"], [tab.session.ref, true, "idle"],
    ]);

    for (let index = 0; index < 16; index += 1) {
      expect((await start(task, { kind: "terminal", clientRequestId: `req_live${index}` })).status).toBe(201);
    }
    const full = await get(task);
    expect(full.sessions.filter((session) => !session.unavailable)).toHaveLength(16);
    expect(full.sessions.some((session) => session.unavailable)).toBe(false);
    expect(full.sessions.filter((session) => session.role === "main")).toHaveLength(1);
    expect((await start(task, { kind: "terminal", clientRequestId: "req_live16" })).status).toBe(409);
  });

  it("keeps sessions available when the liveness source fails", async () => {
    const task = await create("Flaky source");
    await start(task, { kind: "chat", clientRequestId: "req_flaky_source" });
    fake.ports.chats.describe = async () => { throw new Error("chat store down"); };
    expect((await get(task)).sessions.map((session) => session.unavailable)).toEqual([undefined]);
  });

});
