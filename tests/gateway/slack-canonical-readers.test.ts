import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { bootstrapChatDatabase, type ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createSlackCanonicalReaders } from "../../packages/gateway/src/slack/canonical-readers.js";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const ownerId = "user_slack_reader", actorId = "user_requester", chatId = "chat_reader", scopeId = "10000000-0000-4000-8000-000000000001";
const at = new Date("2026-09-30T11:00:00Z");
const resultInput = { ownerId, chatId, scopeId, queuedTurnId: "qturn_reader" };
const acceptedInput = { ownerId, chatId, scopeId, actorId, clientRequestId: "actor_request" };
describe("Slack reads exact canonical queued requests and committed assistant output", () => {
  let fixture: CollaborationTestDatabase;
  let db: Kysely<ChatDatabase>;
  let readers: ReturnType<typeof createSlackCanonicalReaders>;
  beforeEach(async () => {
    fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealCollaborationTestDatabase() : createCollaborationTestDatabase());
    db = fixture.db as unknown as Kysely<ChatDatabase>;
    await bootstrapChatDatabase(db);
    readers = createSlackCanonicalReaders(db);
    await new ChatRepository(db).create({ type: "personal", ownerId }, { id: chatId, clientRequestId: "req_create_reader", title: "Reader" });
    await fixture.db.insertInto("chat_queued_turns").values({ id: resultInput.queuedTurnId, chat_id: chatId, client_request_id: "canonical_request",
      actor_request_id: acceptedInput.clientRequestId, requesting_actor_id: actorId, collaboration_scope_id: scopeId, payload_hash: "a".repeat(64),
      position: 1, status: "queued", parts: "[]", driver_kind: "matrix_bot", instance_id: "matrix_bot_default", selection: "{}",
      interaction_mode: "default", permission_mode: "supervised", execution_root: null, execution_root_fingerprint: null,
      capability_snapshot: "{}", claimed_turn_id: null, claimed_run_id: null, cancelled_at: null, created_at: at, updated_at: at }).execute();
  });
  afterEach(async () => { await fixture.destroy(); });
  async function run(status: "completed" | "running" | "failed" | "aborted" = "completed", targetChat = chatId) {
    if (targetChat !== chatId) await new ChatRepository(db).create({ type: "personal", ownerId }, { id: targetChat, clientRequestId: "req_create_other", title: "Other" });
    await fixture.db.insertInto("chat_messages").values({ id: "msg_input", chat_id: targetChat, seq: 1, role: "user", purpose: "ai_request", state: "committed", turn_id: null, run_id: null, actor_id: actorId, parts: "[]", byte_count: 2, search_text: "", created_at: at }).execute();
    await fixture.db.insertInto("chat_turns").values({ id: "cturn_reader", chat_id: targetChat, client_request_id: "turn_request", base_message_seq: 0, input_message_id: "msg_input", status: "accepted", created_at: at, updated_at: at }).execute();
    await fixture.db.insertInto("chat_runs").values({ id: "run_reader", chat_id: targetChat, turn_id: "cturn_reader", client_request_id: "turn_request", attempt: 1,
      driver_kind: "matrix_bot", instance_id: "matrix_bot_default", selection: "{}", interaction_mode: "default", permission_mode: "supervised", execution_root: null,
      execution_root_fingerprint: null, status, outcome: null, started_at: at, completed_at: null, history_boundary_seq: 1, capability_snapshot: "{}", created_at: at, updated_at: at }).execute();
    await fixture.db.updateTable("chat_queued_turns").set({ claimed_turn_id: "cturn_reader", claimed_run_id: "run_reader", status: "claimed" }).where("id", "=", resultInput.queuedTurnId).execute();
  }
  async function message(seq: number, parts: unknown, overrides: { byte_count?: number; role?: "assistant" | "user"; purpose?: "assistant" | "discussion"; state?: "committed" | "pending"; run_id?: string | null } = {}) {
    await fixture.db.insertInto("chat_messages").values({ id: `msg_reader_${seq}`, chat_id: chatId, seq, role: "assistant", purpose: "assistant", state: "committed",
      turn_id: "cturn_reader", run_id: "run_reader", actor_id: null, parts: JSON.stringify(parts), byte_count: Buffer.byteLength(JSON.stringify(parts)), search_text: "", created_at: at, ...overrides }).execute();
  }
  it("looks up an accepted request only for its exact owner, Chat, scope, actor and client request", async () => {
    expect(await readers.findAcceptedRequest!(acceptedInput)).toEqual({ queuedTurnId: resultInput.queuedTurnId, payloadHash: "a".repeat(64) });
    for (const changed of [{ ownerId: "user_other" }, { chatId: "chat_other" }, { scopeId: "10000000-0000-4000-8000-000000000002" }, { actorId: "user_other" }, { clientRequestId: "other_request" }])
      expect(await readers.findAcceptedRequest!({ ...acceptedInput, ...changed })).toBeNull();
    await fixture.db.updateTable("chats").set({ owner_type: "organization" }).where("id", "=", chatId).execute();
    expect(await readers.findAcceptedRequest!(acceptedInput)).toBeNull();
  });
  it("rejects missing, unattributed, foreign-owner, foreign-Chat and foreign-scope requests", async () => {
    for (const changed of [{ queuedTurnId: "qturn_absent" }, { ownerId: "user_other" }, { chatId: "chat_other" }, { scopeId: "10000000-0000-4000-8000-000000000002" }])
      await expect(readers.readResult({ ...resultInput, ...changed })).rejects.toMatchObject({ code: "forbidden" });
    await fixture.db.updateTable("chat_queued_turns").set({ requesting_actor_id: null }).execute();
    await expect(readers.readResult(resultInput)).rejects.toMatchObject({ code: "forbidden" });
  });
  it.each(["cancelled", "interrupted", "unauthorized", "unavailable"] as const)("returns failed for terminal queue state %s", async status => {
    await fixture.db.updateTable("chat_queued_turns").set({ status }).execute();
    expect(await readers.readResult(resultInput)).toEqual({ status: "failed", requestingActorId: actorId });
  });
  it("distinguishes an unclaimed request from a running canonical run", async () => {
    expect(await readers.readResult(resultInput)).toEqual({ status: "pending", requestingActorId: actorId });
    await run("running");
    expect(await readers.readResult(resultInput)).toEqual({ status: "pending", requestingActorId: actorId, runId: "run_reader" });
  });
  it.each(["failed", "aborted"] as const)("returns failed for terminal canonical run %s", async status => {
    await run(status);
    expect(await readers.readResult(resultInput)).toEqual({ status: "failed", requestingActorId: actorId, runId: "run_reader" });
  });
  it("rejects a corrupted queue pointer to a different Chat's run", async () => {
    await run("completed", "chat_other");
    await expect(readers.readResult(resultInput)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("combines only committed assistant-purpose text in sequence and accepts legacy serialized parts", async () => {
    await run();
    await message(3, JSON.stringify([{ type: "text", text: "second" }]));
    await message(2, [null, "unsafe", { type: "image", text: "ignored" }, { type: "text", text: 42 }, { type: "text", text: "first " }]);
    await message(4, [{ type: "text", text: "private discussion" }], { purpose: "discussion" });
    await message(5, [{ type: "text", text: "uncommitted draft" }], { state: "pending" });
    await message(6, [{ type: "text", text: "requester prompt" }], { role: "user" });
    await message(7, [{ type: "text", text: "other run" }], { run_id: null });
    expect(await readers.readResult(resultInput)).toEqual({ status: "completed", requestingActorId: actorId, runId: "run_reader", text: "first second" });
  });
  it("rejects malformed persisted assistant parts instead of publishing them", async () => {
    await run(); await message(2, { not: "an array" });
    await expect(readers.readResult(resultInput)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("caps text, message bytes, message count and parts count", async () => {
    await run(); await message(2, [{ type: "text", text: "a".repeat(13000) }]); await message(3, [{ type: "text", text: "must not append" }]);
    expect((await readers.readResult(resultInput)).text).toBe("a".repeat(12000));
    await fixture.db.deleteFrom("chat_messages").where("role", "=", "assistant").execute();
    await message(2, [{ type: "text", text: "oversized" }], { byte_count: 65537 });
    expect((await readers.readResult(resultInput)).text).toBe("");
    await fixture.db.deleteFrom("chat_messages").where("role", "=", "assistant").execute();
    await message(2, Array.from({ length: 65 }, () => ({ type: "text", text: "x" })));
    for (let seq = 3; seq <= 23; seq++) await message(seq, [{ type: "text", text: "y" }]);
    expect((await readers.readResult(resultInput)).text).toBe("x".repeat(64) + "y".repeat(19));
  });
});
