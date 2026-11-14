import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KyselyPGlite } from "kysely-pglite";
import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository, ChatBusyError, ChatConflictError, ChatNotFoundError } from "../../packages/gateway/src/chat/repository.js";
import { nativeScheduledRequestHash, nativeScheduledRequestId } from "../../packages/gateway/src/chat/native-scheduled-admission.js";

const owner = { type: "personal" as const, ownerId: "owner_native_cron" };
const sessionId = "66a1f859-6832-494b-850b-de12ba965416";
const promptId = "7b295150-d86a-47a3-a163-ac4e40e85de0";
const timestamp = "2026-11-03T00:00:00.000Z";
const selection = { instanceId: "claude_code_default", model: "claude-haiku-4-5-20251001" };
const source = { sourceRunId: "run_source", sessionId, promptId, prompt: "Report the current time." };
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

describe("private native scheduled phase admission", () => {
  let database: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;
  beforeEach(async () => {
    database = await createTestPGlite(); repository = new ChatRepository(database.dialect); await repository.bootstrap();
    await repository.create(owner, { id: "chat_native", clientRequestId: "req_create", title: "Native Cron" });
    await repository.admitTurn(owner, admission("chat_native", 1, "source", "user"));
    await repository.updateAdapterState(owner, { chatId: "chat_native", runId: "run_source", driverKind: "claude_code",
      instanceId: selection.instanceId, schemaVersion: 1, state: { sessionId } });
    await repository.finishRun(owner, { chatId: "chat_native", runId: "run_source", outcome: "completed", completedAt: timestamp });
  });
  afterEach(async () => { await repository.kysely.destroy(); });
  async function tick(suffix = "tick") {
    const record = await repository.get(owner, "chat_native");
    const input = admission("chat_native", record!.chat.messageCount + 1, suffix, "system");
    input.baseRevision = record!.chat.revision;
    return repository.admitNativeScheduledTurn(owner, input, source);
  }
  it("atomically admits a system input and a fresh run, then permits ordinary streaming and completion", async () => {
    const accepted = await tick();
    expect(accepted.message).toMatchObject({ role: "system", purpose: "system" });
    expect(accepted.message.actorId).toBeUndefined();
    expect(accepted.run.id).not.toBe(source.sourceRunId);
    await repository.markRunRunning(owner, { chatId: "chat_native", runId: accepted.run.id, startedAt: timestamp });
    await repository.appendAssistantDelta(owner, { chatId: "chat_native", runId: accepted.run.id,
      messageId: "msg_scheduled_result", delta: "Native result", createdAt: timestamp });
    await repository.finishRun(owner, { chatId: "chat_native", runId: accepted.run.id, outcome: "completed", completedAt: timestamp });
    const exported = await repository.exportChat(owner, "chat_native");
    expect(exported!.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(exported!.messages.at(-1)).toMatchObject({ role: "assistant", parts: [{ type: "text", text: "Native result" }] });
    expect(exported!.runs).toHaveLength(2);
  });
  it("replays one native occurrence without a second turn, run or system message", async () => {
    const first = await tick();
    const repeated = await tick("different_generated_ids");
    expect(repeated.alreadyAccepted).toBe(true);
    expect(repeated.run.id).toBe(first.run.id);
    const exported = await repository.exportChat(owner, "chat_native");
    expect(exported!.turns).toHaveLength(2);
    expect(exported!.messages.filter(message => message.role === "system")).toHaveLength(1);
  });
  it("rejects raw native prompt display even through private admission", async () => {
    const input = admission("chat_native", 2, "unsafe_display", "system");
    input.baseRevision = (await repository.get(owner, "chat_native"))!.chat.revision;
    input.message.parts = [{ type: "text", text: source.prompt }];
    await expect(repository.admitNativeScheduledTurn(owner, input, source)).rejects.toBeInstanceOf(ChatConflictError);
    expect((await repository.exportChat(owner, "chat_native"))!.messages).toHaveLength(1);
  });
  it("keeps public ordinary admission unable to inject a system turn", async () => {
    const input = admission("chat_native", 2, "forged", "system");
    input.baseRevision = (await repository.get(owner, "chat_native"))!.chat.revision;
    await expect(repository.admitTurn(owner, input)).rejects.toBeInstanceOf(ChatConflictError);
  });
  it.each(["wrong_session", "missing_source", "changed_prompt", "changed_instance"])("rejects %s before any scheduled writes", async mode => {
    const record = (await repository.get(owner, "chat_native"))!;
    const input = admission("chat_native", 2, "rejected", "system");input.baseRevision = record.chat.revision;
    const invalid = { ...source };
    if (mode === "wrong_session") invalid.sessionId = "2c221907-3271-45e7-8763-e17c08d4d842";
    if (mode === "missing_source") invalid.sourceRunId = "run_missing";
    if (mode === "changed_prompt") invalid.prompt = "A different task";
    if (mode === "changed_instance") { input.run.instanceId = "claude_other"; input.run.selection = { ...selection, instanceId: "claude_other" }; }
    await expect(repository.admitNativeScheduledTurn(owner, input, invalid)).rejects.toBeInstanceOf(ChatConflictError);
    expect((await repository.exportChat(owner, "chat_native"))!.runs).toHaveLength(1);
  });
  it("does not acquire another owner's source", async () => {
    const input = admission("chat_native", 2, "foreign", "system");
    input.baseRevision = (await repository.get(owner, "chat_native"))!.chat.revision;
    const foreign = { ...owner, ownerId: "foreign" };
    input.turn.clientRequestId = nativeScheduledRequestId({ owner: foreign, chatId: "chat_native", ...source });
    input.requestHash = nativeScheduledRequestHash({ owner: foreign, chatId: "chat_native", ...source });
    await expect(repository.admitNativeScheduledTurn(foreign, input, source)).rejects.toBeInstanceOf(ChatNotFoundError);
  });
  it("rejects active foreground work without enqueueing or replaying native inference", async () => {
    const record = (await repository.get(owner, "chat_native"))!;
    const foreground = admission("chat_native", 2, "foreground", "user");foreground.baseRevision = record.chat.revision;
    await repository.admitTurn(owner, foreground);
    const input = admission("chat_native", 3, "busy", "system");input.baseRevision = (await repository.get(owner, "chat_native"))!.chat.revision;
    await expect(repository.admitNativeScheduledTurn(owner, input, source)).rejects.toBeInstanceOf(ChatBusyError);
    expect((await repository.exportChat(owner, "chat_native"))!.runs).toHaveLength(2);
  });
  it("rejects a retired native session after a later user turn records a different session", async () => {
    const input = admission("chat_native", 2, "replacement", "user");
    input.baseRevision = (await repository.get(owner, "chat_native"))!.chat.revision;
    await repository.admitTurn(owner, input);
    await repository.updateAdapterState(owner, { chatId: "chat_native", runId: input.run.id,
      driverKind: "claude_code", instanceId: selection.instanceId, schemaVersion: 1,
      state: { sessionId: "22222222-2222-4222-8222-222222222222" } });
    await repository.finishRun(owner, { chatId: "chat_native", runId: input.run.id, outcome: "completed", completedAt: timestamp });
    await expect(tick()).rejects.toBeInstanceOf(ChatConflictError);
  });
  it("fences a Chat that became shared before the scheduled transaction", async () => {
    await repository.kysely.updateTable("chats").set({ collaboration: JSON.stringify({
      scopeId: "10000000-0000-4000-8000-000000000099", mode: "discussion_only", executionFenced: true,
    }) }).where("id", "=", "chat_native").execute();
    const input = admission("chat_native", 2, "shared", "system");
    input.baseRevision = Number((await repository.kysely.selectFrom("chats").select("revision").where("id", "=", "chat_native").executeTakeFirstOrThrow()).revision);
    await expect(repository.admitNativeScheduledTurn(owner, input, source)).rejects.toBeInstanceOf(ChatConflictError);
    expect(await repository.kysely.selectFrom("chat_runs").select("id").where("chat_id", "=", "chat_native").execute()).toHaveLength(1);
  });
  it("fences a changed execution-root project", async () => {
    await repository.kysely.updateTable("chats").set({ project_id: "project_changed" }).where("id", "=", "chat_native").execute();
    const input = admission("chat_native", 2, "root_changed", "system");
    input.baseRevision = Number((await repository.kysely.selectFrom("chats").select("revision").where("id", "=", "chat_native").executeTakeFirstOrThrow()).revision);
    await expect(repository.admitNativeScheduledTurn(owner, input, source)).rejects.toBeInstanceOf(ChatConflictError);
  });
  it("rejects an archived Chat and source binding changes", async () => {
    const record = (await repository.get(owner, "chat_native"))!;
    await repository.update(owner, "chat_native", { baseRevision: record.chat.revision, lifecycle: "archived" });
    await expect(tick()).rejects.toBeInstanceOf(ChatConflictError);
  });
});
