import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";
import { createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";
import { ChatRepository, ChatBusyError, ChatConflictError } from "../../packages/gateway/src/chat/repository.js";
import { nativeScheduledRequestHash, nativeScheduledRequestId } from "../../packages/gateway/src/chat/native-scheduled-admission.js";

const owner = { type: "personal" as const, ownerId: "owner_native_cron_pg" };
const sessionId = "66a1f859-6832-494b-850b-de12ba965416";
const promptId = "7b295150-d86a-47a3-a163-ac4e40e85de0";
const timestamp = "2026-11-03T00:00:00.000Z";
const selection = { instanceId: "claude_code_default", model: "claude-haiku-4-5-20251001" };
const source = { sourceRunId: "run_source", sessionId, promptId, prompt: "PRIVATE_NATIVE_CRON_PROMPT_MUST_NOT_BE_STORED" };
const capabilitySnapshot = {
  revision: "catalog_native_cron", rootChat: true, attachments: [], resources: [], tools: [],
  approvals: true, userInput: true, resume: true, cancellation: true, steering: "same_run" as const,
  worktrees: "optional" as const, interactionModes: ["default"], permissionModes: ["supervised"],
};
function admission(chatId: string, seq: number, suffix: string, role: "user" | "system") {
  const turnId = `cturn_${suffix}`;
  const message: CanonicalChatMessage = { id: `msg_${suffix}`, chatId, seq, role, state: "committed",
    purpose: role === "system" ? "system" : "ai_request", turnId,
    parts: [{ type: "text", text: role === "system" ? "Scheduled task triggered." : "Schedule this task." }], createdAt: timestamp };
  const turn: CanonicalChatTurn = { id: turnId, chatId, clientRequestId: role === "system"
    ? nativeScheduledRequestId({ owner, chatId, ...source }) : `req_${suffix}`,
  baseMessageSeq: seq - 1, inputMessageId: message.id, status: "accepted", createdAt: timestamp, updatedAt: timestamp };
  const run: CanonicalChatRun = { id: `run_${suffix}`, chatId, turnId, attempt: 1, driverKind: "claude_code",
    instanceId: selection.instanceId, selection, interactionMode: "default", permissionMode: "supervised",
    status: "accepted", historyBoundarySeq: seq - 1, capabilitySnapshot, createdAt: timestamp, updatedAt: timestamp };
  return { chatId, baseRevision: seq - 1, message, turn, run,
    ...(role === "system" ? { requestHash: nativeScheduledRequestHash({ owner, chatId, ...source }) } : {}) };
}

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
realDescribe("native scheduled admission PostgreSQL concurrency", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;
  let baseRevision: number;
  let baselineOutbox: number;
  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db); await repository.bootstrap();
    await repository.create(owner, { id: "chat_native", clientRequestId: "req_create", title: "Native Cron PG" });
    await repository.admitTurn(owner, admission("chat_native", 1, "source", "user"));
    await repository.updateAdapterState(owner, { chatId: "chat_native", runId: "run_source", driverKind: "claude_code",
      instanceId: selection.instanceId, schemaVersion: 1, state: { sessionId } });
    await repository.finishRun(owner, { chatId: "chat_native", runId: "run_source", outcome: "completed", completedAt: timestamp });
    baseRevision = (await repository.get(owner, "chat_native"))!.chat.revision;
    baselineOutbox = (await outbox()).length;
  });
  afterEach(async () => { if (fixture) await fixture.destroy(); });
  const next = (suffix: string, role: "user" | "system" = "system") => ({
    ...admission("chat_native", 2, suffix, role), baseRevision,
  });
  const outbox = () => fixture.db.selectFrom("chat_outbox").selectAll().where("chat_id", "=", "chat_native").execute();
  async function assertWrites(expectedNew: number) {
    const exported = (await repository.exportChat(owner, "chat_native"))!;
    expect(exported.turns).toHaveLength(1 + expectedNew);
    expect(exported.runs).toHaveLength(1 + expectedNew);
    expect(exported.messages).toHaveLength(1 + expectedNew);
    const rows = await outbox(); expect(rows).toHaveLength(baselineOutbox + expectedNew);
    expect(JSON.stringify({ exported, rows })).not.toContain(source.prompt);
    return exported;
  }
  it("concurrent identical occurrences commit one system input, run and outbox event", async () => {
    const results = await Promise.all([
      repository.admitNativeScheduledTurn(owner, next("duplicate_a"), source),
      repository.admitNativeScheduledTurn(owner, next("duplicate_b"), source),
    ]);
    expect(results[0]!.run.id).toBe(results[1]!.run.id);
    expect(results.map(result => result.alreadyAccepted).sort()).toEqual([false, true]);
    const exported = await assertWrites(1);
    expect(exported.messages.filter(message => message.role === "system")).toEqual([
      expect.objectContaining({ purpose: "system", parts: [{ type: "text", text: "Scheduled task triggered." }] }),
    ]);
  });
  it("a native occurrence racing an ordinary user turn accepts exactly one and leaves no losing writes", async () => {
    const results = await Promise.allSettled([
      repository.admitNativeScheduledTurn(owner, next("race_native"), source),
      repository.admitTurn(owner, next("race_user", "user")),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason instanceof ChatBusyError || rejected.reason instanceof ChatConflictError).toBe(true);
    const exported = await assertWrites(1);
    expect(exported.messages[1]!.role).toBe(results[0]!.status === "fulfilled" ? "system" : "user");
  });
  it.each(["selection", "checkpoint"])("revalidates %s drift committed while admission actually waits for the Chat lock", async drift => {
    let signalLocked!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const blocker = fixture.db.transaction().execute(async trx => {
      await trx.selectFrom("chats").select("id").where("id", "=", "chat_native").forUpdate().executeTakeFirstOrThrow();
      signalLocked(); await released;
      // Keep revision fixed: this specifically proves source revalidation after the lock,
      // rather than merely exercising the existing revision comparison.
      if (drift === "selection") await trx.updateTable("chats").set({
        current_selection: sql`${JSON.stringify({ ...selection, model: "different-current-model" })}::jsonb`,
      }).where("id", "=", "chat_native").execute();
      else await trx.updateTable("chat_run_adapter_state").set({
        state: sql`${JSON.stringify({ sessionId: "different-native-session" })}::jsonb`,
      }).where("run_id", "=", source.sourceRunId).execute();
    });
    await locked;
    const attempted = repository.admitNativeScheduledTurn(owner, next(`locked_${drift}`), source);
    const rejected = expect(attempted).rejects.toBeInstanceOf(ChatConflictError);
    try {
      await expect.poll(async () => {
        const result = await sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE '%chats%'`.execute(fixture.db);
        return result.rows[0]!.waiting;
      }, { timeout: 1000, interval: 10 }).toBeGreaterThan(0);
    } finally { release(); await blocker; }
    await rejected;
    await assertWrites(0);
  });
});
