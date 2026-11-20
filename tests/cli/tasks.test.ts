import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tasksCommand } from "../../packages/sync-client/src/cli/commands/tasks.js";
import { taskFixture } from "../contracts/fixtures/project-task.js";

const roots: string[] = [];
const originalHome = process.env.HOME;
type Call = { method: string; path: string; body?: unknown };

beforeEach(async () => {
  process.exitCode = undefined;
  const root = await mkdtemp(join(tmpdir(), "matrix-tasks-cli-"));
  roots.push(root);
  process.env.HOME = root;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function gateway(route: (call: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const call: Call = { method: init.method ?? "GET", path: `${parsed.pathname}${parsed.search}`, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
    const custom = route(call);
    if (custom) return custom;
    if (parsed.pathname === "/api/workspace/projects") return json({ projects: [{ id: "proj_alpha", slug: "matrix-os", name: "Matrix" }], nextCursor: null });
    if (parsed.pathname.endsWith("/tasks") && call.method === "GET") return json({ tasks: [taskFixture()], nextCursor: null });
    if (parsed.pathname.endsWith("/comments")) return json({ comment: { id: "tcm_1", taskId: "task_42", author: "agent:chat_1", body: "PR is up", createdAt: "2026-11-20T10:00:00.000Z", editedAt: null } }, 201);
    if (parsed.pathname.endsWith("/start")) return json({ task: taskFixture(), session: { ref: "term.ws1.tab1", kind: "terminal", title: "MOS-42 codex", role: "main", agentStatus: "working" } }, 201);
    return json({ task: taskFixture() }, call.method === "POST" && parsed.pathname.endsWith("/tasks") ? 201 : 200);
  }));
  return calls;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => { out.push(String(line)); });
  vi.spyOn(console, "error").mockImplementation((line?: unknown) => { err.push(String(line)); });
  return { out, err };
}

async function run(name: string, args: Record<string, unknown>) {
  const command = tasksCommand.subCommands![name as keyof typeof tasksCommand.subCommands] as unknown as { run: (input: unknown) => Promise<void> };
  await command.run({ args: { dev: true, token: "tok", json: false, _: [], ...args }, rawArgs: [] });
}

function inTaskSession() {
  vi.stubEnv("MATRIX_PROJECT_ID", "proj_alpha");
  vi.stubEnv("MATRIX_TASK_ID", "task_42");
}

// Fault detected: an agent in a task session had to know ids and slugs to report progress,
// so `matrix tasks comment "PR is up"` and `matrix tasks done` did nothing useful.
describe("matrix tasks inside a task session", () => {
  it("comments on the session's own task with no id", async () => {
    inTaskSession();
    const calls = gateway();
    const { out } = capture();
    await run("comment", { first: "PR is up" });
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/workspace/projects?visibility=all",
      "POST /api/projects/matrix-os/tasks/task_42/comments",
    ]);
    expect(calls[1]!.body).toEqual({ body: "PR is up" });
    expect(out.join("\n")).toMatch(/Comment added/);
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses done while the task's agent works, and closes it with --force", async () => {
    inTaskSession();
    const calls = gateway((call) => call.path.endsWith("/move") && !(call.body as { force?: boolean }).force
      ? json({ error: { code: "task_agent_working", message: "Agent working" } }, 409) : undefined);
    const { err } = capture();
    await run("done", {});
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/--force/);
    process.exitCode = undefined;
    await run("done", { force: true });
    expect(process.exitCode).toBeUndefined();
    expect(calls.filter((call) => call.path.endsWith("/move")).map((call) => call.body)).toEqual([
      { status: "done" }, { status: "done", force: true },
    ]);
  });

  it("refuses another project from inside the session before touching its tasks", async () => {
    inTaskSession();
    const calls = gateway();
    const { out } = capture();
    await run("list", { project: "secret-project", json: true });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ error: { code: "project_out_of_scope" } });
    expect(calls.some((call) => call.path.includes("secret-project"))).toBe(false);
  });

  it("starts work for the session's task with the requested session kind", async () => {
    inTaskSession();
    const calls = gateway();
    const { out } = capture();
    await run("start", { kind: "terminal", harness: "codex", worktree: "existing" });
    expect(calls.at(-1)).toMatchObject({ path: "/api/projects/matrix-os/tasks/task_42/start", body: { kind: "terminal", harness: "codex", worktree: "existing" } });
    expect(out.join("\n")).toContain("MOS-42");
  });

  // Fault detected: start sent no model selection, so the gateway made an empty chat and
  // returned the first message, which the CLI dropped while reporting success.
  it("prints the first message the gateway did not send and says no agent turn started", async () => {
    inTaskSession();
    const firstMessage = "MOS-42 Fix login\n\nThe form \u001b[31mbreaks\u001b[0m.\n\nUse the new endpoint";
    gateway((call) => call.path.endsWith("/start")
      ? json({ task: taskFixture(), session: { ref: "chat_9", kind: "chat", title: "MOS-42", role: "main", agentStatus: "idle" }, firstMessage }, 201)
      : undefined);
    const { out } = capture();
    await run("start", { message: "Use the new endpoint" });
    const printed = out.join("\n");
    expect(printed).toMatch(/no agent turn was started/i);
    expect(printed).toContain("The form breaks.");
    expect(printed).toContain("Use the new endpoint");
    expect(printed).not.toContain("\u001b");

    out.length = 0;
    await run("start", { json: true });
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, data: { session: { ref: "chat_9" }, firstMessage, agentStarted: false } });
  });

  it("reports an agent turn as started when the gateway sent the first message", async () => {
    inTaskSession();
    gateway((call) => call.path.endsWith("/start")
      ? json({ task: taskFixture(), session: { ref: "chat_9", kind: "chat", title: "MOS-42", role: "main", agentStatus: "working" } }, 201)
      : undefined);
    const { out } = capture();
    await run("start", { json: true });
    expect(JSON.parse(out[0]!).data).toMatchObject({ agentStarted: true });
    expect(JSON.parse(out[0]!).data.firstMessage).toBeUndefined();
  });
});

describe("matrix tasks with an explicit project", () => {
  it("asks for a project outside a task session", async () => {
    const calls = gateway();
    const { err } = capture();
    await run("list", {});
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/--project/);
    expect(calls).toEqual([]);
  });

  it("resolves a display key, in either argument order for move", async () => {
    const calls = gateway();
    capture();
    await run("get", { first: "MOS-42", project: "matrix-os" });
    expect(calls.map((call) => call.path)).toEqual([
      "/api/projects/matrix-os/tasks?q=MOS-42&limit=50&includeArchived=true",
      "/api/projects/matrix-os/tasks/task_42",
    ]);
    await run("move", { first: "MOS-42", second: "in_review", project: "matrix-os" });
    await run("move", { first: "todo", second: "task_42", project: "matrix-os" });
    expect(calls.filter((call) => call.path.endsWith("/move")).map((call) => call.body)).toEqual([{ status: "in_review" }, { status: "todo" }]);
  });

  it("creates with a retry key and comma-separated labels and prints the key", async () => {
    const calls = gateway((call) => call.method === "POST" && call.path.endsWith("/tasks") ? json({ task: taskFixture({ id: "task_43", key: "MOS-43", title: "Write docs" }) }, 201) : undefined);
    const { out } = capture();
    await run("create", { first: "Write docs", label: "docs,cli", priority: "high", project: "matrix-os" });
    const body = calls.at(-1)!.body as Record<string, unknown>;
    expect(body).toMatchObject({ title: "Write docs", labels: ["docs", "cli"], priority: "high" });
    expect(String(body.clientRequestId)).toMatch(/^req_/);
    expect(out.join("\n")).toContain("MOS-43");
  });

  it("updates against the revision it read and explains a conflict without overwriting", async () => {
    const calls = gateway((call) => call.method === "PATCH"
      ? json({ error: { code: "task_revision_conflict", message: "Changed" }, task: taskFixture({ revision: 5 }) }, 409) : undefined);
    const { err } = capture();
    await run("update", { first: "task_42", title: "Renamed", project: "matrix-os" });
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([{ baseRevision: 3, title: "Renamed" }]);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/revision 5/);
    expect(err.join("\n")).toMatch(/matrix tasks get/);
  });

  it("prints lists for people and a versioned envelope for machines", async () => {
    gateway();
    const { out } = capture();
    await run("list", { project: "matrix-os" });
    expect(out).toEqual(["MOS-42  in_progress  normal  Ship the board"]);
    out.length = 0;
    await run("list", { project: "matrix-os", json: true });
    expect(JSON.parse(out[0]!)).toMatchObject({ v: 1, ok: true, data: { tasks: [{ key: "MOS-42" }] } });
  });

  it("prints the key and title for open, without terminal control sequences", async () => {
    gateway((call) => call.path.endsWith("/task_42") ? json({ task: taskFixture({ title: "Evil\u001b]0;pwned\u0007 title" }) }) : undefined);
    const { out } = capture();
    await run("open", { first: "task_42", project: "matrix-os" });
    expect(out.join("\n")).toContain("MOS-42");
    expect(out.join("\n")).not.toContain("\u001b");
  });

  it("reports a generic error without the server's text", async () => {
    gateway(() => new Response("relation project_tasks does not exist", { status: 500 }));
    const { err } = capture();
    await run("get", { first: "task_42", project: "matrix-os" });
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).not.toContain("relation");
  });

  // Fault detected: `--description ""` was read as a missing flag, so a description could not be cleared.
  it("clears a description with an explicitly empty value and leaves it alone when the flag is absent", async () => {
    const calls = gateway();
    capture();
    await run("update", { first: "task_42", description: "", project: "matrix-os" });
    await run("update", { first: "task_42", title: "Renamed", project: "matrix-os" });
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
      { baseRevision: 3, description: "" }, { baseRevision: 3, title: "Renamed" },
    ]);
  });

  // Fault detected: comments and activity stopped at the first page and the CLI dropped nextCursor.
  it("shows where task history continues and reads the next page with --cursor", async () => {
    const calls = gateway((call) => {
      if (call.path.includes("/comments")) return json({ comments: [], nextCursor: "tcm_9" });
      if (call.path.includes("/activity")) return json({ activity: [], nextCursor: "41" });
      return undefined;
    });
    const { out } = capture();
    await run("get", { first: "task_42", project: "matrix-os", comments: true });
    expect(out.join("\n")).toContain("More comments: --comments --cursor tcm_9");
    await run("get", { first: "task_42", project: "matrix-os", activity: true, cursor: "41", json: true });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, data: { activity: [], activityNextCursor: "41" } });
    expect(calls.filter((call) => /comments|activity/.test(call.path)).map((call) => call.path)).toEqual([
      "/api/projects/matrix-os/tasks/task_42/comments?limit=50",
      "/api/projects/matrix-os/tasks/task_42/activity?after=41&limit=50",
    ]);
    await run("get", { first: "task_42", project: "matrix-os", comments: true, activity: true, cursor: "41" });
    expect(process.exitCode).toBe(1);
  });
});

describe("matrix tasks get output", () => {
  it("shows the due date, relations, comment count and unavailable sessions", async () => {
    const { taskDetail } = await import("../../packages/sync-client/src/cli/project-task-cli.js");
    const lines = taskDetail({
      ...taskFixture(),
      dueAt: new Date(2026, 10, 24, 17, 0).toISOString(),
      parentTaskId: "task_parent",
      blockedBy: ["task_blocker"],
      commentCount: 2,
      sessions: [{ ref: "chat_gone", kind: "chat", title: "Old chat", role: "main", agentStatus: "idle", unavailable: true }],
    });
    expect(lines).toEqual(expect.arrayContaining([
      "due: 2026-11-24", "parent: task_parent", "blocked by: task_blocker", "comments: 2", "chat: Old chat (unavailable)",
    ]));
  });
});
