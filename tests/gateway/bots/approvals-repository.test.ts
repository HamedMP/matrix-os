import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotApprovalsRepository } from "../../../packages/gateway/src/bots/repositories/approvals.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let approvalId: string;
let binding: { taskId: string; tool: string; argsHash: string; account: string; audience: string; policyRevision: number };

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, "chat_approve1");
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_approve1", now: NOW });
  binding = { taskId: task.taskId, tool: "integration.call", argsHash: "d".repeat(64), account: "gmail:work@example.com", audience: "direct", policyRevision: 3 };
  approvalId = (await createBotInteractionsRepository(db).create({
    ownerId: OWNER, botId: BOT, chatId: "chat_approve1", taskId: task.taskId, kind: "approval",
    payload: { kind: "approval" }, responderActorId: OWNER, blocking: true, expiresAt: at(60 * 60_000), now: NOW,
  })).interaction.interactionId;
  await createBotApprovalsRepository(db).create({ ownerId: OWNER, approvalId, botId: BOT, runId: "run_approve1", ...binding, expiresAt: at(60 * 60_000), now: NOW });
});
afterEach(async () => destroy());

describe("bot approvals repository", () => {
  it("decides once, then claims once for the exact binding", async () => {
    const repo = createBotApprovalsRepository(db);
    await expect(repo.claim({ ownerId: OWNER, approvalId, ...binding, now: at(1) })).resolves.toEqual({ status: "refused", reason: "not_claimable" });
    const approved = await repo.decide({ ownerId: OWNER, approvalId, baseRevision: 1, decision: "approved", now: at(1) });
    expect(approved).toMatchObject({ status: "approved", revision: 2 });
    await expect(repo.decide({ ownerId: OWNER, approvalId, baseRevision: 2, decision: "denied", now: at(2) }))
      .rejects.toEqual(new BotStateError("invalid_transition"));
    await expect(repo.decide({ ownerId: OTHER_OWNER, approvalId, baseRevision: 2, decision: "denied", now: at(2) }))
      .rejects.toEqual(new BotStateError("not_found"));
    const claimed = await repo.claim({ ownerId: OWNER, approvalId, ...binding, now: at(3) });
    expect(claimed).toMatchObject({ status: "claimed", approval: { claimedAt: at(3) } });
    await expect(repo.claim({ ownerId: OWNER, approvalId, ...binding, now: at(4) })).resolves.toEqual({ status: "refused", reason: "not_claimable" });
    await expect(repo.claim({ ownerId: OTHER_OWNER, approvalId, ...binding, now: at(4) })).rejects.toEqual(new BotStateError("not_found"));
  });

  it("invalidates an approval when the action changed, and the invalidation commits with the caller", async () => {
    const repo = createBotApprovalsRepository(db);
    await repo.decide({ ownerId: OWNER, approvalId, baseRevision: 1, decision: "approved", now: at(1) });
    // The refusal is returned, so the caller's transaction commits the invalidation.
    const refusal = await db.transaction().execute((trx) => repo.claim({ ownerId: OWNER, approvalId, ...binding, argsHash: "e".repeat(64), now: at(2) }, trx));
    expect(refusal).toEqual({ status: "refused", reason: "invalidated" });
    await expect(repo.get({ ownerId: OWNER, approvalId })).resolves.toMatchObject({ status: "invalidated" });
    // The original arguments cannot use it either once invalidated.
    await expect(repo.claim({ ownerId: OWNER, approvalId, ...binding, now: at(3) })).resolves.toEqual({ status: "refused", reason: "invalidated" });
  });

  it("leaves an expired approval for the expiry sweep when a changed action tries to claim it", async () => {
    const repo = createBotApprovalsRepository(db);
    await repo.decide({ ownerId: OWNER, approvalId, baseRevision: 1, decision: "approved", now: at(1) });
    const late = at(60 * 60_000 + 1);
    await expect(repo.claim({ ownerId: OWNER, approvalId, ...binding, argsHash: "e".repeat(64), now: late }))
      .resolves.toEqual({ status: "refused", reason: "not_claimable" });
    await expect(repo.get({ ownerId: OWNER, approvalId })).resolves.toMatchObject({ status: "approved" });
    await expect(repo.expireDue({ now: late })).resolves.toEqual([approvalId]);
    await expect(repo.get({ ownerId: OWNER, approvalId })).resolves.toMatchObject({ status: "expired" });
  });

  it("finds the task's open approval of an exact action, and lets a later run of the task claim it", async () => {
    const repo = createBotApprovalsRepository(db);
    await expect(repo.findOpen({ ownerId: OWNER, taskId: binding.taskId, tool: binding.tool, argsHash: binding.argsHash })).resolves.toMatchObject({ approvalId, status: "pending", runId: "run_approve1" });
    await expect(repo.findOpen({ ownerId: OWNER, taskId: binding.taskId, tool: binding.tool, argsHash: "e".repeat(64) })).resolves.toBeUndefined();
    await repo.decide({ ownerId: OWNER, approvalId, baseRevision: 1, decision: "approved", now: at(1) });
    // The run that asked has ended; the continuation claims it by task.
    await expect(repo.claim({ ownerId: OWNER, approvalId, ...binding, now: at(2) })).resolves.toMatchObject({ status: "claimed" });
    await expect(repo.findOpen({ ownerId: OWNER, taskId: binding.taskId, tool: binding.tool, argsHash: binding.argsHash })).resolves.toBeUndefined();
  });

  it("expires undecided and unclaimed approvals", async () => {
    const repo = createBotApprovalsRepository(db);
    await expect(repo.expireDue({ now: at(30 * 60_000) })).resolves.toEqual([]);
    await expect(repo.expireDue({ now: at(60 * 60_000) })).resolves.toEqual([approvalId]);
    await expect(repo.decide({ ownerId: OWNER, approvalId, baseRevision: 2, decision: "approved", now: at(60 * 60_000 + 1) }))
      .rejects.toEqual(new BotStateError("invalid_transition"));
  });
});
