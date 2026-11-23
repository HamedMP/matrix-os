import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely, sql } from "kysely";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatService } from "../../../packages/gateway/src/chat/service.js";
import { bootstrapProjectTaskDatabase, type ProjectTaskDatabase } from "../../../packages/gateway/src/project-tasks/database.js";
import { ProjectTaskCommentRepository } from "../../../packages/gateway/src/project-tasks/comments.js";
import { ProjectTaskRepository } from "../../../packages/gateway/src/project-tasks/repository.js";
import { ProjectTaskService } from "../../../packages/gateway/src/project-tasks/service.js";
import { ProjectTaskSessionRepository } from "../../../packages/gateway/src/project-tasks/sessions.js";
import { createProjectChatHook } from "../../../packages/gateway/src/project-tasks/task-chats.js";
import { createTaskSessionPorts } from "../../../packages/gateway/src/server/project-task-sessions.js";

const OWNER = { type: "user" as const, id: "user_owner" };
const CHAT_OWNER = { type: "personal" as const, ownerId: OWNER.id };
const CALLER = { ownerScope: OWNER, actor: "user:user_owner" as const };
const PROJECTS: Record<string, { id: string; slug: string }> = {
  proj_demo: { id: "proj_demo", slug: "board-demo" },
  proj_other: { id: "proj_other", slug: "other-work" },
};

/** Every task is a chat: the chat store and the board share one owner database and one transaction. */
describe("task chats over the owner chat store", () => {
  let chatRepository: ChatRepository;
  let tasks: ProjectTaskRepository;
  let service: ProjectTaskService;
  let chats: ReturnType<typeof createTaskSessionPorts>["chats"];
  let projectLookupFails = false;
  const events: Array<{ type: string; taskId: string }> = [];

  const projects = {
    async getProject(slug: string) {
      const project = Object.values(PROJECTS).find((candidate) => candidate.slug === slug);
      return project ? { ok: true as const, project: project as never } : { ok: false as const, status: 404, error: { code: "not_found", message: "" } };
    },
    async getProjectById(_scope: unknown, projectId: string) {
      if (projectLookupFails) return { ok: false as const, status: 503, error: { code: "project_index_unavailable", message: "" } };
      const project = PROJECTS[projectId];
      return project ? { ok: true as const, project: project as never } : { ok: false as const, status: 404, error: { code: "not_found", message: "" } };
    },
  };

  beforeEach(async () => {
    projectLookupFails = false;
    events.length = 0;
    chatRepository = new ChatRepository((await createTestPGlite()).dialect);
    await chatRepository.bootstrap();
    const db = chatRepository.kysely as unknown as Kysely<ProjectTaskDatabase>;
    await bootstrapProjectTaskDatabase(db);
    tasks = new ProjectTaskRepository(db);
    chats = createTaskSessionPorts({
      homePath: "/home/owner", projectManager: {} as never, worktreeManager: {} as never,
      chats: { service: createCanonicalChatService(chatRepository), repository: chatRepository },
      terminalRuntime: {} as never,
    }).chats;
    service = new ProjectTaskService({
      repository: tasks, comments: new ProjectTaskCommentRepository(db), members: async () => [], projects,
      legacyTasks: { listTasks: async () => ({ ok: true as const, tasks: [], nextCursor: null }) },
      publish: async (event) => { events.push({ type: event.type, taskId: event.taskId }); },
      sessions: new ProjectTaskSessionRepository(db), chats,
    });
  });
  afterEach(async () => { await chatRepository.kysely.destroy(); });

  const install = () => chatRepository.setProjectChatHook(createProjectChatHook({ repository: tasks, projects }));
  const createChat = (requestId: string, projectId?: string, title = "Fix the login page") =>
    createCanonicalChatService(chatRepository).create(CHAT_OWNER, { clientRequestId: requestId, title, ...(projectId ? { projectId } : {}) });
  const taskFor = (chatId: string) => tasks.findByChatAny(OWNER.id, chatId);
  const chatRow = (chatId: string) => chatRepository.kysely.selectFrom("chats").selectAll().where("id", "=", chatId).executeTakeFirst();

  async function addRun(chatId: string, id: string, status: string, at: string) {
      await sql`INSERT INTO chat_messages (id, chat_id, seq, role, state, parts, byte_count, created_at)
        VALUES (${`msg_${id}`}, ${chatId}, ${Number(at.slice(-6, -4))}, 'user', 'committed', '[]'::jsonb, 0, ${at})`.execute(chatRepository.kysely);
      await sql`INSERT INTO chat_turns (id, chat_id, client_request_id, base_message_seq, input_message_id, status, created_at, updated_at)
        VALUES (${`turn_${id}`}, ${chatId}, ${`req_${id}`}, 0, ${`msg_${id}`}, 'accepted', ${at}, ${at})`.execute(chatRepository.kysely);
      await sql`INSERT INTO chat_runs (id, chat_id, turn_id, client_request_id, attempt, driver_kind, instance_id, selection, interaction_mode,
        permission_mode, status, history_boundary_seq, capability_snapshot, created_at, updated_at)
        VALUES (${`run_${id}`}, ${chatId}, ${`turn_${id}`}, ${`req_${id}`}, 1, 'kernel', 'inst', '{}'::jsonb, 'default', 'default',
        ${status}, 0, '{}'::jsonb, ${at}, ${at})`.execute(chatRepository.kysely);
  }

  it("gives a chat started in a project a task in To do, and none to chats outside a project", async () => {
    install();
    const project = await createChat("req_plain_project", "proj_demo");
    const loose = await createChat("req_plain_loose");
    const unknown = await createChat("req_plain_unknown", "proj_gone");

    expect(await taskFor(project.chat.id)).toMatchObject({
      project_id: "proj_demo", status: "todo", title: "Fix the login page", number: 1, created_by: "system:chat",
    });
    expect(await taskFor(loose.chat.id)).toBeUndefined();
    expect(await taskFor(unknown.chat.id)).toBeUndefined();
  });

  it("creates a board task as an empty chat in Backlog, once per request id", async () => {
    install();
    const body = { title: "Write the release notes", priority: "high" as const, labels: ["docs"], clientRequestId: "req_board_1" };
    const first = await service.createTask(CALLER, "board-demo", body);
    const again = await service.createTask(CALLER, "board-demo", body);

    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, task: { id: first.task.id } });
    expect(first.task).toMatchObject({ status: "backlog", priority: "high", labels: ["docs"], title: "Write the release notes", createdBy: "user:user_owner" });
    expect(await chatRow(first.task.chatId!)).toMatchObject({ title: "Write the release notes", project_id: "proj_demo", message_count: 0, lifecycle: "active" });
    const byChat = await service.listTasks(CALLER, "board-demo", { limit: 1, includeArchived: false, chatId: first.task.chatId! });
    expect(byChat.tasks.map((task) => task.id)).toEqual([first.task.id]);
    const runs = await chatRepository.kysely.selectFrom("chat_runs").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow();
    expect(Number(runs.n)).toBe(0);
  });

  it("keeps the title one value: renaming either side renames both", async () => {
    install();
    const { task } = await service.createTask(CALLER, "board-demo", { title: "Old name", clientRequestId: "req_title" });
    const chat = await chatRow(task.chatId!);
    await chatRepository.rename(CHAT_OWNER, task.chatId!, { title: "Renamed in chat", expectedTitleVersion: Number(chat!.title_version) });
    expect((await taskFor(task.chatId!))?.title).toBe("Renamed in chat");

    const current = await service.getTask(CALLER, "board-demo", task.id);
    const renamed = await service.updateTask(CALLER, "board-demo", task.id, { baseRevision: current.revision, title: "Renamed on board" });
    expect(renamed.title).toBe("Renamed on board");
    expect(await chatRow(task.chatId!)).toMatchObject({ title: "Renamed on board", title_manual: true });

    // A generated title never overwrites a title the person set on the board.
    const after = await chatRow(task.chatId!);
    await chatRepository.updateGeneratedTitle(CHAT_OWNER, task.chatId!, { title: "Generated", expectedTitleVersion: Number(after!.title_version) });
    expect((await taskFor(task.chatId!))?.title).toBe("Renamed on board");
  });

  it("archives and restores both sides together", async () => {
    install();
    const { task } = await service.createTask(CALLER, "board-demo", { title: "Archive me", clientRequestId: "req_archive" });
    const chat = await chatRow(task.chatId!);
    await chatRepository.update(CHAT_OWNER, task.chatId!, { baseRevision: Number(chat!.revision), lifecycle: "archived" });
    expect((await taskFor(task.chatId!))?.archived_at).not.toBeNull();

    await service.setArchived(CALLER, "board-demo", task.id, false);
    expect((await chatRow(task.chatId!))?.lifecycle).toBe("active");
    await service.setArchived(CALLER, "board-demo", task.id, true);
    expect((await chatRow(task.chatId!))?.lifecycle).toBe("archived");
  });

  it("moves a task with its chat between projects, and archives it when the chat leaves projects", async () => {
    install();
    await createChat("req_move_filler", "proj_other");
    const created = await createChat("req_move", "proj_demo");
    let chat = await chatRow(created.chat.id);
    await chatRepository.update(CHAT_OWNER, created.chat.id, { baseRevision: Number(chat!.revision), projectId: "proj_other" });
    expect(await taskFor(created.chat.id)).toMatchObject({ project_id: "proj_other", number: 2, archived_at: null });

    chat = await chatRow(created.chat.id);
    await chatRepository.update(CHAT_OWNER, created.chat.id, { baseRevision: Number(chat!.revision), projectId: null });
    const left = await taskFor(created.chat.id);
    expect(left?.project_id).toBe("proj_other");
    expect(left?.archived_at).not.toBeNull();
  });

  it("deletes both sides together", async () => {
    install();
    const viaChat = await createChat("req_delete_chat", "proj_demo");
    await chatRepository.hardDelete(CHAT_OWNER, { chatId: viaChat.chat.id, clientRequestId: "req_delete_chat_1" });
    expect((await taskFor(viaChat.chat.id))?.deleted_at).not.toBeNull();

    const { task } = await service.createTask(CALLER, "board-demo", { title: "Delete from board", clientRequestId: "req_delete_board" });
    await service.deleteTask(CALLER, "board-demo", task.id);
    expect(await chatRow(task.chatId!)).toBeUndefined();
  });

  it("rolls the chat back when its task cannot be written", async () => {
    install();
    projectLookupFails = true;
    await expect(createChat("req_rollback", "proj_demo")).rejects.toThrow();
    const row = await chatRepository.kysely.selectFrom("chats").select("id").where("create_request_id", "=", "req_rollback").executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("backfills earlier project chats into Done, or In progress while their agent runs, and gives chatless tasks a chat, once", async () => {
    const old = await createChat("req_old_chat", "proj_demo", "An old conversation");
    const waiting = await createChat("req_old_waiting", "proj_demo", "Waiting on me");
    await addRun(old.chat.id, "o1", "completed", "2026-11-01T00:00:01.000Z");
    await addRun(waiting.chat.id, "w1", "waiting_for_input", "2026-11-01T00:00:02.000Z");
    const archived = await createChat("req_old_archived", "proj_demo", "Archived conversation");
    await chatRepository.update(CHAT_OWNER, archived.chat.id, { baseRevision: archived.chat.revision, lifecycle: "archived" });
    await tasks.ensureBoard({ ownerId: OWNER.id, projectId: "proj_demo" }, "BD");
    const legacy = await tasks.createTask({ ownerId: OWNER.id, projectId: "proj_demo" }, {
      id: "task_legacy", title: "From the old task list", clientRequestId: "req_legacy", payloadHash: "0".repeat(64),
    }, "system:import");
    install();

    const { tasks: listed } = await service.listTasks(CALLER, "board-demo", { limit: 50, includeArchived: true });
    expect(listed.find((task) => task.chatId === old.chat.id)).toMatchObject({ status: "done", title: "An old conversation", archivedAt: null });
    expect(listed.find((task) => task.chatId === waiting.chat.id)?.status).toBe("in_progress");
    expect(listed.find((task) => task.chatId === archived.chat.id)).toMatchObject({ status: "done" });
    expect(listed.find((task) => task.chatId === archived.chat.id)?.archivedAt).not.toBeNull();
    const linked = listed.find((task) => task.id === legacy.row.id)!;
    expect(linked.chatId).toMatch(/^chat_/);
    expect(await chatRow(linked.chatId!)).toMatchObject({ title: "From the old task list", project_id: "proj_demo" });
    expect((await tasks.getBoard({ ownerId: OWNER.id, projectId: "proj_demo" }))?.chats_linked_at).not.toBeNull();

    const again = await service.listTasks(CALLER, "board-demo", { limit: 50, includeArchived: true });
    expect(again.tasks).toHaveLength(4);
  });

  it("moves a Backlog task to In progress when its chat's first turn is accepted, and only then", async () => {
    install();
    const { task } = await service.createTask(CALLER, "board-demo", { title: "Start on first message", clientRequestId: "req_first_turn" });
    await service.chatChanged(OWNER, task.chatId!, "turn.accepted");
    expect((await service.getTask(CALLER, "board-demo", task.id)).status).toBe("in_progress");
    expect(events.at(-1)).toEqual({ type: "task.updated", taskId: task.id });

    await service.moveTask(CALLER, "board-demo", task.id, { status: "todo" });
    await service.chatChanged(OWNER, task.chatId!, "chat.updated");
    expect((await service.getTask(CALLER, "board-demo", task.id)).status).toBe("todo");
  });

  it("reads the latest run status of each task's chat", async () => {
    install();
    const first = await createChat("req_status_a", "proj_demo");
    await addRun(first.chat.id, "a1", "completed", "2026-11-01T00:00:01.000Z");
    await addRun(first.chat.id, "a2", "waiting_for_input", "2026-11-01T00:00:02.000Z");
    const task = await taskFor(first.chat.id);
    expect((await service.getTask(CALLER, "board-demo", task!.id)).chatStatus).toBe("blocked");
    expect(await chats.statuses({ type: "user", id: "someone_else" }, [first.chat.id])).toEqual({});
  });
});

describe("task chat wiring beside the chat event stream", () => {
  // Fault detected: the chat outbox held one sink, the event stream registers it first, so
  // the board's registration threw and the gateway crashed at boot.
  it("registers the board on a chat repository whose event stream already holds the sink, and both receive events", async () => {
    const chatRepository = new ChatRepository((await createTestPGlite()).dialect);
    try {
      await chatRepository.bootstrap();
      const db = chatRepository.kysely as unknown as Kysely<ProjectTaskDatabase>;
      await bootstrapProjectTaskDatabase(db);
      const streamed: string[] = [];
      chatRepository.registerOutboxSink(({ event }) => { streamed.push(event.eventType); });
      const published: string[] = [];
      const { registerProjectTaskRoutes } = await import("../../../packages/gateway/src/server/project-task-routes.js");
      const { Hono } = await import("hono");
      expect(() => registerProjectTaskRoutes({
        app: new Hono(), homePath: "/home/owner", repository: new ProjectTaskRepository(db),
        projectManager: { getProject: async () => ({ ok: true, project: PROJECTS.proj_demo }), getProjectById: async (_scope: unknown, id: string) => (PROJECTS[id] ? { ok: true, project: PROJECTS[id] } : { ok: false, status: 404, error: { code: "not_found", message: "" } }) } as never,
        eventPublisher: { publish: async (event: { type: string }) => { published.push(event.type); } } as never,
        collaboration: null, worktreeManager: {} as never, chatRepository, chatOrchestrator: null, chatExecutionRoots: null,
        terminalRuntime: {} as never,
      })).not.toThrow();

      await createCanonicalChatService(chatRepository).create(CHAT_OWNER, { clientRequestId: "req_wired", title: "Wired", projectId: "proj_demo" });
      expect(streamed).toContain("chat.created");
      await vi.waitFor(() => expect(published).toContain("task.created"));
    } finally {
      await chatRepository.kysely.destroy();
    }
  });
});
