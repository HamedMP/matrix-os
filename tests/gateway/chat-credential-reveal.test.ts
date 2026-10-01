import { afterEach, beforeEach, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ChatCredentialRepository } from "../../packages/gateway/src/chat/credential-repository.js";
import { createChatCredentialRoutes } from "../../packages/gateway/src/chat/credential-routes.js";
import { ChatSharing, bootstrapChatSharing } from "../../packages/gateway/src/chat/sharing.js";
import { assistantCredentialOccurrenceId, sealAssistantCredential } from "../../packages/gateway/src/chat/assistant-credential-crypto.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { Hono } from "hono";
import { sql } from "kysely";

const owner = { type: "personal" as const, ownerId: "owner_secret" };
const other = { type: "personal" as const, ownerId: "other_secret" };
const key = Buffer.alloc(32, 7);
const safe = "Token: [redacted credential]";
let repository: ChatRepository;
let credentials: ChatCredentialRepository;
let chatId: string;
let runId: string;
let createdAt: string;

beforeEach(async () => {
  const db = await KyselyPGlite.create();
  repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  credentials = new ChatCredentialRepository(repository.kysely, key, [owner.ownerId]);
  const { snapshot } = createCanonicalChatFixture("running");
  chatId = snapshot.chat.id;
  runId = snapshot.runs[0]!.id;
  createdAt = snapshot.chat.createdAt;
  await repository.create(owner, { id: chatId, clientRequestId: "req_credentials", title: "Secrets" });
  const { startedAt: _startedAt, ...run } = snapshot.runs[0]!;
  await repository.admitTurn(owner, {
    chatId, baseRevision: 0, message: snapshot.messages[0]!,
    turn: { ...snapshot.turns[0]!, status: "accepted" },
    run: { ...run, status: "accepted" },
  });
  await repository.markRunRunning(owner, { chatId, runId, startedAt: createdAt });
});
afterEach(async () => { await repository.kysely.destroy(); });

async function appendCredential() {
  const messageId = "msg_credential";
  const occurrenceId = assistantCredentialOccurrenceId(messageId, 7);
  const envelope = sealAssistantCredential(key, {
    ownerId: owner.ownerId, chatId, runId, messageId, occurrenceId,
  }, "qa-fake-token-123");
  await repository.appendAssistantDelta(owner, {
    chatId, runId, messageId, delta: safe, createdAt,
    credentials: [{ occurrenceId, offset: 7, length: "[redacted credential]".length, envelope }],
  });
  return { messageId, occurrenceId };
}

it("atomically stores a sealed sidecar while all ordinary Chat data stays masked", async () => {
  const { messageId, occurrenceId } = await appendCredential();
  const detail = await repository.getDetailPage(owner, chatId, { limit: 100 });
  const exported = await repository.exportChat(owner, chatId);
  const outbox = await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 });
  const ordinary = JSON.stringify({ detail, exported, outbox });
  expect(ordinary).toContain("[redacted credential]");
  expect(ordinary).not.toContain("qa-fake-token-123");
  expect(ordinary).not.toContain(occurrenceId);
  expect(ordinary).not.toContain("ciphertext");
  const metadata = await credentials.list(owner, chatId, [messageId]);
  expect(metadata).toEqual([{ id: occurrenceId, messageId, offset: 7,
    length: "[redacted credential]".length, revealed: false }]);
  const row = await repository.kysely.selectFrom("chat_credentials").selectAll()
    .where("id", "=", occurrenceId).executeTakeFirstOrThrow();
  expect(JSON.stringify(row)).not.toContain("qa-fake-token-123");
});

it("keeps a captured prose credential available after an image attachment is appended", async () => {
  const { messageId, occurrenceId } = await appendCredential();
  await repository.appendAssistantAttachment(owner, {
    chatId, runId, messageId, createdAt,
    attachment: {
      id: "attachment_credential_chart", kind: "image", label: "chart.png",
      path: `data/chat-artifacts/codex/sha256/${"a".repeat(64)}.png`,
      mimeType: "image/png", sizeBytes: 12,
    },
  });
  expect(await credentials.list(owner, chatId, [messageId])).toEqual([{
    id: occurrenceId, messageId, offset: 7,
    length: "[redacted credential]".length, revealed: false,
  }]);
  expect(await credentials.reveal(owner, chatId, occurrenceId)).toMatchObject({ value: "qa-fake-token-123" });
});

it("rolls back masked message and outbox when ciphertext storage fails", async () => {
  await sql`CREATE FUNCTION reject_chat_credential() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'forced sidecar storage failure'; END;
  $$`.execute(repository.kysely);
  await sql`CREATE TRIGGER reject_chat_credential_insert BEFORE INSERT ON chat_credentials
    FOR EACH ROW EXECUTE FUNCTION reject_chat_credential()`.execute(repository.kysely);
  const before = await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 });
  await expect(appendCredential()).rejects.toThrow();
  expect(await repository.kysely.selectFrom("chat_messages").select("id")
    .where("id", "=", "msg_credential").executeTakeFirst()).toBeUndefined();
  expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 })).toEqual(before);
});

it("requires current private runtime ownership and persists explicit reveal until manual hide", async () => {
  const { messageId, occurrenceId } = await appendCredential();
  await expect(credentials.reveal(other, chatId, occurrenceId)).rejects.toThrow();
  await expect(new ChatCredentialRepository(repository.kysely, key, []).reveal(owner, chatId, occurrenceId)).rejects.toThrow();
  await expect(credentials.value(owner, chatId, occurrenceId)).rejects.toThrow();
  expect(await credentials.reveal(owner, chatId, occurrenceId)).toEqual({
    id: occurrenceId, value: "qa-fake-token-123", revealed: true,
  });
  const restarted = new ChatCredentialRepository(repository.kysely, key, [owner.ownerId]);
  expect(await restarted.list(owner, chatId, [messageId])).toEqual([{ id: occurrenceId, messageId, offset: 7,
    length: "[redacted credential]".length, revealed: true }]);
  expect(await restarted.value(owner, chatId, occurrenceId)).toEqual({
    id: occurrenceId, value: "qa-fake-token-123", revealed: true,
  });
  expect(await restarted.hide(owner, chatId, occurrenceId)).toEqual({ id: occurrenceId, revealed: false });
  await expect(restarted.value(owner, chatId, occurrenceId)).rejects.toThrow();
});

it("keeps the value unavailable after key loss without a plaintext fallback", async () => {
  const { messageId, occurrenceId } = await appendCredential();
  await credentials.reveal(owner, chatId, occurrenceId);
  const wrongKey = new ChatCredentialRepository(repository.kysely, Buffer.alloc(32, 9), [owner.ownerId]);
  expect(await wrongKey.list(owner, chatId, [messageId])).toMatchObject([{ id: occurrenceId, revealed: true }]);
  await expect(wrongKey.value(owner, chatId, occurrenceId)).rejects.toThrow("Credential unavailable");
  await expect(new ChatCredentialRepository(repository.kysely, undefined, [owner.ownerId])
    .value(owner, chatId, occurrenceId)).rejects.toThrow("Credential unavailable");
});

it("revokes previously revealed values when live collaboration begins, including stale reads", async () => {
  const { messageId, occurrenceId } = await appendCredential();
  await credentials.reveal(owner, chatId, occurrenceId);
  await repository.kysely.updateTable("chats")
    .set({ collaboration: JSON.stringify({ scopeId: "scope_shared", mode: "discussion_only" }) })
    .where("id", "=", chatId).execute();
  await expect(credentials.value(owner, chatId, occurrenceId)).rejects.toThrow();
  await expect(credentials.reveal(owner, chatId, occurrenceId)).rejects.toThrow();
  await expect(credentials.list(owner, chatId, [messageId])).rejects.toThrow();
});

it("cascades encrypted occurrences on hard delete", async () => {
  const { occurrenceId } = await appendCredential();
  await repository.finishRun(owner, { chatId, runId, outcome: "completed", completedAt: createdAt });
  await repository.hardDelete(owner, { chatId, clientRequestId: "req_delete_credentials" });
  expect(await repository.kysely.selectFrom("chat_credentials").select("id")
    .where("id", "=", occurrenceId).executeTakeFirst()).toBeUndefined();
});

it("exposes only bounded owner metadata and single-value actions over no-store routes", async () => {
  const { messageId, occurrenceId } = await appendCredential();
  let actor = owner.ownerId;
  const app = new Hono().route("/", createChatCredentialRoutes({
    repository: credentials,
    getPrincipal: () => ({ userId: actor, source: "jwt" }),
  }));
  const base = `/api/chats/${chatId}/credentials`;
  const metadata = await app.request(`${base}?messageIds=${messageId}`);
  expect(metadata.status).toBe(200);
  expect(metadata.headers.get("cache-control")).toBe("no-store");
  expect(await metadata.json()).toEqual({ occurrences: [{ id: occurrenceId, messageId, offset: 7,
    length: "[redacted credential]".length, revealed: false }] });
  expect((await app.request(`${base}/${occurrenceId}/value`)).status).toBe(404);
  const reveal = await app.request(`${base}/${occurrenceId}/reveal`, { method: "POST" });
  expect(reveal.headers.get("cache-control")).toBe("no-store");
  expect(await reveal.json()).toEqual({ id: occurrenceId, value: "qa-fake-token-123", revealed: true });
  const rehydrate = await app.request(`${base}/${occurrenceId}/value`);
  expect(await rehydrate.json()).toEqual({ id: occurrenceId, value: "qa-fake-token-123", revealed: true });
  actor = other.ownerId;
  expect((await app.request(`${base}/${occurrenceId}/value`)).status).toBe(404);
  actor = owner.ownerId;
  expect((await app.request(`${base}/${occurrenceId}/hide`, { method: "POST", body: "{}" })).status).toBe(200);
  expect((await app.request(`${base}/${occurrenceId}/value`)).status).toBe(404);
  expect((await app.request(`${base}?messageIds=${Array(65).fill(messageId).join(",")}`)).status).toBe(400);
  expect((await app.request(`${base}/${occurrenceId}/reveal`, { method: "POST", body: JSON.stringify({ ownerId: other.ownerId }) })).status).toBe(400);
});

it("keeps a private reveal visible after a public snapshot while the snapshot stays masked", async () => {
  const { occurrenceId } = await appendCredential();
  await repository.finishRun(owner, { chatId, runId, outcome: "completed", completedAt: createdAt });
  await credentials.reveal(owner, chatId, occurrenceId);
  await bootstrapChatSharing(repository.kysely);
  const shares = new ChatSharing(repository.kysely);
  const current = (await repository.get(owner, chatId))!;
  const created = await shares.create(owner, chatId, current.chat.revision);
  const snapshot = await shares.read(created.token);
  expect(JSON.stringify(snapshot)).toContain("[redacted credential]");
  expect(JSON.stringify(snapshot)).not.toContain("qa-fake-token-123");
  expect(await credentials.value(owner, chatId, occurrenceId)).toMatchObject({ value: "qa-fake-token-123" });
});
