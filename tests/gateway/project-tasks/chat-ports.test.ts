import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatService } from "../../../packages/gateway/src/chat/service.js";
import { createTaskSessionPorts } from "../../../packages/gateway/src/server/project-task-sessions.js";

const OWNER = { type: "user" as const, id: "user_owner" };
const CHAT_OWNER = { type: "personal" as const, ownerId: OWNER.id };

describe("board chat port over the owner chat store", () => {
  let repository: ChatRepository;
  let chats: ReturnType<typeof createTaskSessionPorts>["chats"];

  beforeEach(async () => {
    repository = new ChatRepository((await createTestPGlite()).dialect);
    await repository.bootstrap();
    chats = createTaskSessionPorts({
      homePath: "/home/owner", projectManager: {} as never, worktreeManager: {} as never,
      chats: { service: createCanonicalChatService(repository), repository }, sessionCredentials: {} as never, terminalRuntime: {} as never,
    }).chats;
  });
  afterEach(async () => { await repository.kysely.destroy(); });

  const createChat = (requestId: string, projectId = "proj_demo") =>
    createCanonicalChatService(repository).create(CHAT_OWNER, { clientRequestId: requestId, title: "BD-1 Task", projectId });

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

  it("reads each chat's latest run status for the owner only", async () => {
    const first = await createChat("req_task_a");
    const other = await createChat("req_task_b", "proj_other");
    await addRun(first.chat.id, "a1", "completed", "2026-11-01T00:00:01.000Z");
    await addRun(first.chat.id, "a2", "waiting_for_input", "2026-11-01T00:00:02.000Z");
    await addRun(other.chat.id, "b1", "failed", "2026-11-01T00:00:03.000Z");
    expect(await chats.statuses(OWNER, [first.chat.id, other.chat.id])).toEqual({ [first.chat.id]: "blocked", [other.chat.id]: "error" });
    expect(await chats.statuses({ type: "user", id: "someone_else" }, [first.chat.id])).toEqual({});
  });

  it("binds the task worktree as the chat's default root and reads the chat revision", async () => {
    const chat = await createChat("req_task_wt");
    await chats.bindWorktree(OWNER, chat.chat.id, { projectId: "proj_demo", worktreeId: "wt_0123456789abcdef" });
    expect(await repository.getExecutionDefault(CHAT_OWNER, chat.chat.id)).toEqual({ projectId: "proj_demo", worktreeId: "wt_0123456789abcdef" });
    // A worktree for another project is never bound to this chat.
    const elsewhere = await createChat("req_task_other", "proj_other");
    await chats.bindWorktree(OWNER, elsewhere.chat.id, { projectId: "proj_demo", worktreeId: "wt_0123456789abcdef" });
    expect(await repository.getExecutionDefault(CHAT_OWNER, elsewhere.chat.id)).toBeNull();

    expect(await chats.revision(OWNER, chat.chat.id)).toBe(chat.chat.revision);
    expect(await chats.revision({ type: "user", id: "someone_else" }, chat.chat.id)).toBeNull();
  });
});
