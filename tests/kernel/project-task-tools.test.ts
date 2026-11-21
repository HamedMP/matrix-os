import { describe, expect, it, vi } from "vitest";
import { ProjectTaskClientError, type ProjectTaskClient } from "../../packages/contracts/src/project-task-client.js";
import {
  PROJECT_TASK_IPC_TOOL_NAMES,
  PROJECT_TASK_TOOL_NAMES,
  projectTaskKernelContext,
  projectTaskToolDefinitions,
  type ProjectTaskToolContext,
} from "../../packages/kernel/src/tools/project-tasks.js";
import { taskFixture } from "../contracts/fixtures/project-task.js";

const SESSION = { projectId: "proj_alpha", projectSlug: "matrix-os", taskId: "task_42" };

function fakeClient(overrides: Partial<ProjectTaskClient> = {}): ProjectTaskClient {
  return {
    listTasks: vi.fn(async () => ({ tasks: [taskFixture()], nextCursor: null })),
    getTask: vi.fn(async () => taskFixture()),
    createTask: vi.fn(async () => taskFixture({ id: "task_43", key: "MOS-43", number: 43 })),
    updateTask: vi.fn(async () => taskFixture({ revision: 4 })),
    moveTask: vi.fn(async () => taskFixture({ status: "done" })),
    listComments: vi.fn(async () => ({ comments: [], nextCursor: null })),
    createComment: vi.fn(async () => ({ id: "tcm_1", taskId: "task_42", author: "agent:chat_1" as const, body: "PR is up", createdAt: "2026-11-20T10:00:00.000Z", editedAt: null })),
    listActivity: vi.fn(async () => ({ activity: [], nextCursor: null })),
    startTask: vi.fn(async () => ({ task: taskFixture(), session: { ref: "chat_9", kind: "chat" as const, title: "MOS-42", role: "extra" as const, agentStatus: "working" as const } })),
    ...overrides,
  };
}

function tools(client: ProjectTaskClient, session: ProjectTaskToolContext["session"] = async () => SESSION) {
  const definitions = projectTaskToolDefinitions({ client, session });
  return async (name: string, input: Record<string, unknown> = {}) => {
    const definition = definitions.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`missing ${name}`);
    const result = await definition.handler(definition.schema.parse(input));
    return { ...result, text: result.content.map((part) => part.text).join("\n") };
  };
}

// Fault detected: agents could not read or update the board their task lives on, and a
// task-session agent could reach another project's tasks.
describe("project task agent tools", () => {
  it("exposes seven distinct names that do not clash with the kernel work queue", () => {
    expect(PROJECT_TASK_TOOL_NAMES).toEqual([
      "project_task_list", "project_task_get", "project_task_create", "project_task_update",
      "project_task_move", "project_task_comment", "project_task_start",
    ]);
    expect(PROJECT_TASK_IPC_TOOL_NAMES).not.toContain("mcp__matrix-os-ipc__list_tasks");
    expect(PROJECT_TASK_IPC_TOOL_NAMES).toContain("mcp__matrix-os-ipc__project_task_list");
  });

  it("lists the session's project and refuses any other project before calling the board", async () => {
    const client = fakeClient();
    const call = tools(client);
    const listed = await call("project_task_list", { status: "todo", q: "board" });
    expect(client.listTasks).toHaveBeenCalledWith("matrix-os", { status: "todo", q: "board" });
    expect(listed.text).toContain("MOS-42");
    expect(listed.text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect((await call("project_task_list", { project: "proj_alpha" })).isError).toBeUndefined();

    const refused = await call("project_task_list", { project: "other-project" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/only reach this session's project/i);
    expect(client.listTasks).toHaveBeenCalledTimes(2);
  });

  it("defaults to the session's task and resolves display keys", async () => {
    const client = fakeClient();
    const call = tools(client);
    await call("project_task_get", {});
    expect(client.getTask).toHaveBeenLastCalledWith("matrix-os", "task_42");
    await call("project_task_get", { task: "MOS-42", comments: true });
    expect(client.listTasks).toHaveBeenCalledWith("matrix-os", expect.objectContaining({ q: "MOS-42" }));
    expect(client.listComments).toHaveBeenCalledWith("matrix-os", "task_42", {});
  });

  // Fault detected: comments and activity stopped at the first page and the tools dropped nextCursor.
  it("returns where comments and activity continue and reads the next page by cursor", async () => {
    const client = fakeClient({
      listComments: vi.fn(async () => ({ comments: [], nextCursor: "tcm_9" })),
      listActivity: vi.fn(async () => ({ activity: [], nextCursor: "41" })),
    });
    const call = tools(client);
    const first = await call("project_task_get", { comments: true, activity: true });
    expect(first.text).toContain('"commentsNextCursor": "tcm_9"');
    expect(first.text).toContain('"activityNextCursor": "41"');
    await call("project_task_get", { comments: true, commentsCursor: "tcm_9", activity: true, activityCursor: "41" });
    expect(client.listComments).toHaveBeenLastCalledWith("matrix-os", "task_42", { cursor: "tcm_9" });
    expect(client.listActivity).toHaveBeenLastCalledWith("matrix-os", "task_42", { cursor: "41" });
  });

  it("refuses a task the board reports in another project", async () => {
    const call = tools(fakeClient({ getTask: vi.fn(async () => taskFixture({ projectId: "proj_other" })) }));
    const result = await call("project_task_get", { task: "task_42" });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("Ship the board");
  });

  it("creates with a retry key and never sends an actor from model input", async () => {
    const client = fakeClient();
    const call = tools(client);
    // The caller holds the retry key, so a retry after a lost response reuses it.
    const schemaOf = (name: string) => projectTaskToolDefinitions({ client, session: async () => SESSION }).find((definition) => definition.name === name)!.schema;
    expect(schemaOf("project_task_create").safeParse({ title: "Write docs" }).success).toBe(false);
    expect(schemaOf("project_task_start").safeParse({ kind: "chat" }).success).toBe(false);
    const created = await call("project_task_create", { title: "Write docs", labels: ["docs"], clientRequestId: "req_docs_1" });
    const body = vi.mocked(client.createTask).mock.calls[0]![1];
    expect(body).toMatchObject({ title: "Write docs", labels: ["docs"], clientRequestId: "req_docs_1" });
    expect(body).not.toHaveProperty("actor");
    expect(created.text).toContain("MOS-43");
    expect(() => projectTaskToolDefinitions({ client, session: async () => SESSION })
      .find((definition) => definition.name === "project_task_create")!.schema.parse({ title: "x", actor: "user:x" })).toThrow();
  });

  it("requires the revision the agent read and explains a conflict instead of overwriting", async () => {
    const client = fakeClient({
      updateTask: vi.fn(async () => { throw new ProjectTaskClientError("task_revision_conflict", { status: 409, task: taskFixture({ revision: 8 }) }); }),
    });
    const call = tools(client);
    expect(projectTaskToolDefinitions({ client, session: async () => SESSION }).find((definition) => definition.name === "project_task_update")!
      .schema.safeParse({ title: "Renamed" }).success).toBe(false);
    const result = await call("project_task_update", { title: "Renamed", baseRevision: 3 });
    expect(client.getTask).not.toHaveBeenCalled();
    expect(client.updateTask).toHaveBeenCalledWith("matrix-os", "task_42", { baseRevision: 3, title: "Renamed" });
    expect(client.updateTask).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/revision 8/);
    expect(result.text).toMatch(/project_task_get/);
  });

  it("refuses to close a task while its agent works unless force is set", async () => {
    const moveTask = vi.fn(async (_slug: string, _id: string, body: { force?: boolean }) => {
      if (!body.force) throw new ProjectTaskClientError("task_agent_working", { status: 409 });
      return taskFixture({ status: "done" });
    });
    const call = tools(fakeClient({ moveTask }));
    const refused = await call("project_task_move", { status: "done" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/force/);
    const moved = await call("project_task_move", { status: "done", force: true });
    expect(moved.isError).toBeUndefined();
    expect(moveTask).toHaveBeenLastCalledWith("matrix-os", "task_42", { status: "done", force: true });
  });

  it("comments on and starts work for the session's task", async () => {
    const client = fakeClient();
    const call = tools(client);
    await call("project_task_comment", { body: "PR is up" });
    expect(client.createComment).toHaveBeenCalledWith("matrix-os", "task_42", { body: "PR is up" });
    const started = await call("project_task_start", { kind: "terminal", worktree: "existing", harness: "codex", clientRequestId: "req_start_1" });
    expect(client.startTask).toHaveBeenCalledWith("matrix-os", "task_42", { kind: "terminal", worktree: "existing", harness: "codex", clientRequestId: "req_start_1" });
    expect(started.text).toContain("chat_9");
    expect(started.text).toContain('"agentStarted": true');
  });

  // Fault detected: the tool dropped the unsent first message and reported success, so the
  // agent believed work had started in an empty chat.
  it("returns the unsent first message and agentStarted false", async () => {
    const client = fakeClient({
      startTask: vi.fn(async () => ({
        task: taskFixture(), session: { ref: "chat_9", kind: "chat" as const, title: "MOS-42", role: "main" as const, agentStatus: "idle" as const },
        firstMessage: "MOS-42 Fix login\n\nUse the new endpoint",
      })),
    });
    const started = await tools(client)("project_task_start", { kind: "chat", message: "Use the new endpoint", clientRequestId: "req_start_2" });
    expect(started.isError).toBeUndefined();
    expect(started.text).toContain('"agentStarted": false');
    expect(started.text).toContain("Use the new endpoint");
    expect(started.text).toMatch(/no agent turn was started/i);
    expect(started.text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  });

  it("asks for a project when the run has none, and for a task when no default exists", async () => {
    const client = fakeClient();
    const call = tools(client, async () => null);
    expect((await call("project_task_list")).text).toMatch(/project/i);
    expect(client.listTasks).not.toHaveBeenCalled();
    await call("project_task_list", { project: "matrix-os" });
    expect(client.listTasks).toHaveBeenCalledWith("matrix-os", {});
    const noTask = await call("project_task_get", { project: "matrix-os" });
    expect(noTask.isError).toBe(true);
    expect(noTask.text).toMatch(/task/i);
  });

  it("returns a generic message when the board fails", async () => {
    const call = tools(fakeClient({ listTasks: vi.fn(async () => { throw new Error("pg password=hunter2"); }) }));
    const result = await call("project_task_list");
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("hunter2");
  });

  it("can expose only the read tools", () => {
    const names = projectTaskToolDefinitions({ client: fakeClient(), session: async () => SESSION }, { readOnly: true }).map((definition) => definition.name);
    expect(names).toEqual(["project_task_list", "project_task_get"]);
  });
});

describe("kernel project task binding", () => {
  it("verifies the injected client and session at registration", async () => {
    expect(() => projectTaskKernelContext(undefined as never)).toThrow();
    expect(() => projectTaskKernelContext({ client: { ...fakeClient(), moveTask: undefined } as never, session: SESSION })).toThrow();
    expect(() => projectTaskKernelContext({ client: fakeClient(), session: { ...SESSION, projectId: "bad" } })).toThrow();
    expect(() => projectTaskKernelContext({ client: fakeClient(), session: { ...SESSION, projectSlug: "Bad Slug" } })).toThrow();
    const context = projectTaskKernelContext({ client: fakeClient(), session: SESSION });
    await expect(context.session()).resolves.toEqual(SESSION);
  });
});
