import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatService } from "../../../packages/gateway/src/chat/service.js";
import { createTaskSessionPorts } from "../../../packages/gateway/src/server/project-task-sessions.js";

const OWNER = { type: "user" as const, id: "user_owner" };

describe("board chat port over the owner chat store", () => {
  let repository: ChatRepository;
  let chats: ReturnType<typeof createTaskSessionPorts>["chats"];

  beforeEach(async () => {
    repository = new ChatRepository((await createTestPGlite()).dialect);
    await repository.bootstrap();
    chats = createTaskSessionPorts({
      homePath: "/home/owner",
      projectManager: {} as never,
      worktreeManager: {} as never,
      chats: { service: createCanonicalChatService(repository), db: repository.kysely },
      sessionCredentials: {} as never,
      terminalRuntime: {} as never,
    }).chats;
  });
  afterEach(async () => { await repository.kysely.destroy(); });

  async function addRun(chatId: string, id: string, status: string, at: string) {
    await sql`INSERT INTO chat_messages (id, chat_id, seq, role, state, parts, byte_count, created_at)
      VALUES (${`msg_${id}`}, ${chatId}, ${Number(at.slice(-6, -4))}, 'user', 'committed', '[]'::jsonb, 0, ${at})`.execute(repository.kysely);
    await sql`INSERT INTO chat_turns (id, chat_id, client_request_id, base_message_seq, input_message_id, status, created_at, updated_at)
      VALUES (${`turn_${id}`}, ${chatId}, ${`req_${id}`}, 0, ${`msg_${id}`}, 'accepted', ${at}, ${at})`.execute(repository.kysely);
    await sql`INSERT INTO chat_runs (id, chat_id, turn_id, client_request_id, attempt, driver_kind, instance_id, selection, interaction_mode,
      permission_mode, status, history_boundary_seq, capability_snapshot, created_at, updated_at)
      VALUES (${`run_${id}`}, ${chatId}, ${`turn_${id}`}, ${`req_${id}`}, 1, 'kernel', 'inst', '{}'::jsonb, 'default', 'default',
      ${status}, 0, '{}'::jsonb, ${at}, ${at})`.execute(repository.kysely);
  }

  it("creates project chats idempotently and lists, describes and reads their latest run status", async () => {
    const first = await chats.create(OWNER, { clientRequestId: "req_task_a", title: "BD-1 Task", projectId: "proj_demo" });
    const again = await chats.create(OWNER, { clientRequestId: "req_task_a", title: "BD-1 Task", projectId: "proj_demo" });
    expect(again.id).toBe(first.id);
    const other = await chats.create(OWNER, { clientRequestId: "req_task_b", title: "Elsewhere", projectId: "proj_other" });

    expect((await chats.listForProject(OWNER, "proj_demo", 10)).map((chat) => chat.id)).toEqual([first.id]);
    expect(await chats.describe(OWNER, [first.id, "chat_missing"])).toEqual([{ id: first.id, title: "BD-1 Task", projectId: "proj_demo" }]);
    expect(await chats.describe({ type: "user", id: "someone_else" }, [first.id])).toEqual([]);

    await addRun(first.id, "a1", "completed", "2026-11-01T00:00:01.000Z");
    await addRun(first.id, "a2", "waiting_for_input", "2026-11-01T00:00:02.000Z");
    await addRun(other.id, "b1", "failed", "2026-11-01T00:00:03.000Z");
    expect(await chats.statuses(OWNER, [first.id, other.id])).toEqual({ [first.id]: "blocked", [other.id]: "error" });
    expect(await chats.statuses({ type: "user", id: "someone_else" }, [first.id])).toEqual({});
  });

  it("binds the task worktree as the chat's default root so later turns without one stay in it", async () => {
    const chat = await chats.create(OWNER, { clientRequestId: "req_task_wt", title: "BD-2 Task", projectId: "proj_demo", worktreeId: "wt_0123456789abcdef" });
    expect(await repository.getExecutionDefault({ type: "personal", ownerId: OWNER.id }, chat.id)).toEqual({ projectId: "proj_demo", worktreeId: "wt_0123456789abcdef" });
    const plain = await chats.create(OWNER, { clientRequestId: "req_task_plain", title: "BD-3 Task", projectId: "proj_demo" });
    expect(await repository.getExecutionDefault({ type: "personal", ownerId: OWNER.id }, plain.id)).toBeNull();
  });
});
