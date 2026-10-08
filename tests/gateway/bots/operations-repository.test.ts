import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotOperationsRepository } from "../../../packages/gateway/src/bots/repositories/operations.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase } from "./bot-state-support.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;

beforeEach(async () => ({ db, destroy } = await createBotStateDatabase()));
afterEach(async () => destroy());

describe("bot operations repository", () => {
  it("reserves once per request with server-chosen IDs and a derived workspace", async () => {
    const repo = createBotOperationsRepository(db);
    const first = await repo.reserve({ ownerId: OWNER, clientRequestId: "req_create_1", payloadHash: HASH_A, now: NOW });
    expect(first.created).toBe(true);
    expect(first.operation).toMatchObject({ status: "reserved", revision: 1, attempts: 0 });
    expect(first.operation.botId).toMatch(/^bot_[a-f0-9]{24}$/);
    expect(first.operation.chatId).toMatch(/^chat_[a-f0-9]{24}$/);
    expect(first.operation.workspaceRelPath).toBe(`bots/${first.operation.botId}`);

    const retry = await repo.reserve({ ownerId: OWNER, clientRequestId: "req_create_1", payloadHash: HASH_A, now: at(1_000) });
    expect(retry).toEqual({ operation: first.operation, created: false });
    await expect(repo.reserve({ ownerId: OWNER, clientRequestId: "req_create_1", payloadHash: HASH_B, now: NOW }))
      .rejects.toEqual(new BotStateError("conflict"));
    // Another owner's identical request key is independent.
    const other = await repo.reserve({ ownerId: OTHER_OWNER, clientRequestId: "req_create_1", payloadHash: HASH_B, now: NOW });
    expect(other.created).toBe(true);
    expect(other.operation.botId).not.toBe(first.operation.botId);
  });

  it("moves through file_created to active at the caller's revision only", async () => {
    const repo = createBotOperationsRepository(db);
    const { operation } = await repo.reserve({ ownerId: OWNER, clientRequestId: "req_create_2", payloadHash: HASH_A, now: NOW });
    await expect(repo.markActive({ ownerId: OWNER, clientRequestId: "req_create_2", baseRevision: 1, now: NOW }))
      .rejects.toEqual(new BotStateError("invalid_transition"));
    const created = await repo.markFileCreated({ ownerId: OWNER, clientRequestId: "req_create_2", baseRevision: 1, now: at(1) });
    expect(created).toMatchObject({ status: "file_created", revision: 2 });
    await expect(repo.markActive({ ownerId: OWNER, clientRequestId: "req_create_2", baseRevision: 1, now: NOW }))
      .rejects.toEqual(new BotStateError("revision_conflict"));
    await expect(repo.markActive({ ownerId: OTHER_OWNER, clientRequestId: "req_create_2", baseRevision: 2, now: NOW }))
      .rejects.toEqual(new BotStateError("not_found"));
    const active = await repo.markActive({ ownerId: OWNER, clientRequestId: "req_create_2", baseRevision: 2, now: at(2) });
    expect(active).toMatchObject({ status: "active", revision: 3, botId: operation.botId, chatId: operation.chatId });
    await expect(repo.markFailed({ ownerId: OWNER, clientRequestId: "req_create_2", baseRevision: 3, failureCode: "late", now: NOW }))
      .rejects.toEqual(new BotStateError("invalid_transition"));
  });

  it("records recoverable failures and lists unfinished creations for reconciliation", async () => {
    const repo = createBotOperationsRepository(db);
    await repo.reserve({ ownerId: OWNER, clientRequestId: "req_old", payloadHash: HASH_A, now: NOW });
    await repo.reserve({ ownerId: OWNER, clientRequestId: "req_new", payloadHash: HASH_A, now: at(60_000) });
    const failed = await repo.markFailed({ ownerId: OWNER, clientRequestId: "req_old", baseRevision: 1, failureCode: "file_write_failed", now: at(1_000) });
    expect(failed).toMatchObject({ status: "failed_recoverable", failureCode: "file_write_failed", attempts: 1 });
    // A retry with the same IDs resumes from failed_recoverable.
    const resumed = await repo.markFileCreated({ ownerId: OWNER, clientRequestId: "req_old", baseRevision: 2, now: at(2_000) });
    expect(resumed).toMatchObject({ status: "file_created", failureCode: null, attempts: 1 });
    await expect(repo.listUnfinished({ olderThan: at(30_000) })).resolves.toEqual([expect.objectContaining({ clientRequestId: "req_old" })]);
    await expect(repo.markFailed({ ownerId: OWNER, clientRequestId: "req_new", baseRevision: 1, failureCode: "BAD CODE", now: NOW }))
      .rejects.toThrow();
  });
});
