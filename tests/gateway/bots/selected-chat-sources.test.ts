import type { Kysely } from "kysely";
import { beforeEach, afterEach, expect, it } from "vitest";
import { createBotSelectedChatReader } from "../../../packages/gateway/src/chat/bot-selected-chat.js";
import { createProductionChatDriveContext } from "../../../packages/gateway/src/chat/drive-context-production.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { jsonb } from "../../../packages/gateway/src/chat/records.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { bootstrapChatSharing, ChatSharing } from "../../../packages/gateway/src/chat/sharing.js";
import type { OwnerCollaborationDatabase } from "../../../packages/gateway/src/collaboration/database.js";
import { BOT, NOW, OWNER, OTHER_OWNER, createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { admitSessionRun } from "./shared-session-run-support.js";

const source = "chat_prior", destination = "chat_onboarding";
const owner = { type: "personal" as const, ownerId: OWNER };
let fixture: Awaited<ReturnType<typeof createBotStateDatabase>>;
let repository: ChatRepository;
let reader: ReturnType<typeof createBotSelectedChatReader>;

async function priorMessage(seq: number, text: string) {
  await repository.kysely.insertInto("chat_messages").values({
    id: `msg_prior_${seq}`, chat_id: source, seq, role: "user", state: "committed", purpose: "discussion",
    run_id: null, turn_id: null, actor_id: OWNER, parts: jsonb([{ type: "text", text }]),
    byte_count: Buffer.byteLength(text), search_text: text, created_at: new Date(NOW),
  }).execute();
}
beforeEach(async () => {
  fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase());
  repository = new ChatRepository(fixture.db as unknown as Kysely<ChatDatabase>);
  await bootstrapChatSharing(repository.kysely);
  await insertChat(fixture.db, source);
  await insertChat(fixture.db, destination);
  reader = createBotSelectedChatReader(repository);
});
afterEach(() => fixture.destroy());

it("pins only bounded selected text and refuses a changed or erased excerpt", async () => {
  await priorMessage(1, "discarded prefix " + "猫".repeat(1000) + " confirm orientation");
  const selected = await reader.prepare(owner, destination, BOT, [source]);
  await priorMessage(2, "Only written after the selection");
  const [excerpt] = JSON.parse(await reader.read(owner, destination, selected));
  expect(excerpt.truncated).toBe(true);
  expect(Buffer.byteLength(excerpt.text)).toBeLessThanOrEqual(2048);
  expect(excerpt.text).toContain("confirm orientation");
  expect(excerpt.text).not.toMatch(/discarded prefix|written after|�/);
  expect(JSON.stringify(selected)).not.toContain("orientation");
  await repository.kysely.deleteFrom("chat_messages").where("id", "=", "msg_prior_1").execute();
  await expect(reader.read(owner, destination, selected)).rejects.toThrow("context_unavailable");
});

it("checks both audiences and rejects other owners, project or archived Chats, active public links and previously shared scopes", async () => {
  await priorMessage(1, "mentor");
  const selected = await reader.prepare(owner, destination, BOT, [source]);
  await insertChat(fixture.db, "chat_other", OTHER_OWNER);
  for (const ids of [[], [destination], [source, source], ["chat_other"], [source, "chat_other"]]) {
    await expect(reader.prepare(owner, destination, BOT, ids)).rejects.toThrow("context_unavailable");
  }
  await expect(reader.read({ ...owner, ownerId: OTHER_OWNER }, destination, selected)).rejects.toThrow("context_unavailable");
  const bindings = createBotBindingsRepository(fixture.db);
  await bindings.bindGroup({ ownerId: OWNER, botId: BOT, chatId: source, now: NOW });
  await expect(reader.read(owner, destination, selected)).rejects.toThrow("context_unavailable");
  await bindings.remove({ ownerId: OWNER, botId: BOT, chatId: source, now: NOW });
  const sharing = new ChatSharing(repository.kysely);
  const link = await sharing.create(owner, source, 0);
  await expect(reader.read(owner, destination, selected)).rejects.toThrow("context_unavailable");
  await sharing.revoke(owner, source, link.id);
  for (const id of [source, destination]) {
    await fixture.db.updateTable("chats").set({ project_id: "project_private" }).where("id", "=", id).execute();
    await expect(reader.read(owner, destination, selected)).rejects.toThrow("context_unavailable");
    await fixture.db.updateTable("chats").set({ project_id: null, lifecycle: "archived" }).where("id", "=", id).execute();
    await expect(reader.read(owner, destination, selected)).rejects.toThrow("context_unavailable");
    await fixture.db.updateTable("chats").set({ lifecycle: "active" }).where("id", "=", id).execute();
  }
  await (fixture.db as unknown as Kysely<OwnerCollaborationDatabase>).insertInto("collaboration_scopes").values({
    id: "62db9a95-8d0b-4c1f-ae18-0aef417302ef", owner_type: "personal", owner_id: OWNER, organization_id: "org_test",
    kind: "chat", resource_id: source, parent_scope_id: null, membership_mode: "direct",
    lifecycle: "deleted", revision: 1, auth_epoch: 1, authority_runtime_id: "runtime_test", authority_generation: 1,
    created_at: NOW, updated_at: NOW, deleted_at: NOW,
  }).execute();
  await expect(reader.read(owner, destination, selected)).rejects.toThrow("context_unavailable");
});

it("retains output in the owner's Bot Chat and blocks link sharing or onward references after completion", async () => {
  await priorMessage(1, "Private mentor assignment");
  const selection = await reader.prepare(owner, destination, BOT, [source]);
  const run = await admitSessionRun(fixture.db, OWNER, destination, "run_private", {
    version: 1, requestHash: "a".repeat(64), chats: [], botChatSources: selection,
  });
  await run.complete();
  const exported = await repository.exportChat(owner, destination);
  expect(exported?.runs[0]?.context?.botChatSources).toEqual(selection);
  expect(JSON.stringify(exported)).not.toContain("Private mentor assignment");
  expect(await repository.exportChat({ ...owner, ownerId: OTHER_OWNER }, destination)).toBeNull();
  await expect(new ChatSharing(repository.kysely).preview(owner, destination)).rejects.toThrow("conflict");
  const service = createProductionChatDriveContext({ repository, collaborationReady: false });
  await expect(service.assertChatReferenceAllowed(owner, destination)).rejects.toThrow();
  await expect(reader.prepare(owner, source, BOT, [destination])).rejects.toThrow("context_unavailable");
});
