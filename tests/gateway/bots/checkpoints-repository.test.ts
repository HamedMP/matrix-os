import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let taskId: string;
const action = { capability: "integration.call", target: "gmail:conn_1", argsHash: "c".repeat(64) };

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, "chat_ckpt1");
  taskId = (await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_ckpt1", now: NOW })).taskId;
});
afterEach(async () => destroy());

const prepare = (repo: ReturnType<typeof createBotCheckpointsRepository>, overrides: Record<string, unknown> = {}) => repo.prepare({
  ownerId: OWNER, taskId, runId: "run_ckpt", toolCallId: "call_1", action, effectClass: "send", now: NOW, ...overrides,
});

describe("bot tool checkpoints repository", () => {
  it("prepares once per tool call and refuses a different action under the same ID", async () => {
    const repo = createBotCheckpointsRepository(db);
    const first = await prepare(repo);
    expect(first).toMatchObject({ created: true, checkpoint: { phase: "prepared", effectClass: "send", action } });
    // Property order does not change the action identity.
    const reordered = await prepare(repo, { action: { argsHash: action.argsHash, target: action.target, capability: action.capability } });
    expect(reordered).toEqual({ checkpoint: first.checkpoint, created: false });
    await expect(prepare(repo, { action: { ...action, target: "gmail:conn_2" } })).rejects.toEqual(new BotStateError("conflict"));
    await expect(prepare(repo, { action: { blob: "x".repeat(5_000) }, toolCallId: "call_big" })).rejects.toEqual(new BotStateError("too_large"));
    // Near the compact limit, JSONB spacing still fits the column bound.
    const near = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`k${index}`, "v".repeat(18)]));
    await expect(prepare(repo, { action: near, toolCallId: "call_near" })).resolves.toMatchObject({ created: true });
  });

  it("records outcomes in phase order and never replays a send", async () => {
    const repo = createBotCheckpointsRepository(db);
    const { checkpoint } = await prepare(repo);
    await expect(repo.markObserved({ ownerId: OWNER, checkpointId: checkpoint.checkpointId, now: NOW }))
      .rejects.toEqual(new BotStateError("invalid_transition"));
    await repo.markDispatched({ ownerId: OWNER, checkpointId: checkpoint.checkpointId, now: at(1) });
    await expect(repo.markDispatched({ ownerId: OTHER_OWNER, checkpointId: checkpoint.checkpointId, now: at(1) }))
      .rejects.toEqual(new BotStateError("not_found"));
    const unknown = await repo.markEffectUnknown({ ownerId: OWNER, checkpointId: checkpoint.checkpointId, now: at(2) });
    expect(unknown.phase).toBe("effect_unknown");
    await expect(repo.retryRead({ ownerId: OWNER, checkpointId: checkpoint.checkpointId, now: at(3) }))
      .rejects.toEqual(new BotStateError("invalid_transition"));
  });

  it("retries an unknown read at most twice", async () => {
    const repo = createBotCheckpointsRepository(db);
    const { checkpoint } = await prepare(repo, { effectClass: "read", toolCallId: "call_read" });
    const id = { ownerId: OWNER, checkpointId: checkpoint.checkpointId };
    await repo.markDispatched({ ...id, now: at(1) });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await repo.markEffectUnknown({ ...id, now: at(attempt * 10) });
      await expect(repo.retryRead({ ...id, now: at(attempt * 10 + 1) })).resolves.toMatchObject({ phase: "dispatched", readRetries: attempt });
    }
    await repo.markEffectUnknown({ ...id, now: at(100) });
    await expect(repo.retryRead({ ...id, now: at(101) })).rejects.toEqual(new BotStateError("invalid_transition"));
    const observed = await repo.listForRun({ ownerId: OWNER, runId: "run_ckpt" });
    expect(observed).toHaveLength(1);
  });

  it("marks stale dispatched checkpoints effect_unknown after a crash, in bounded batches", async () => {
    const repo = createBotCheckpointsRepository(db);
    for (const [index, dispatchedAt] of [NOW, at(1_000), at(90_000)].entries()) {
      const { checkpoint } = await prepare(repo, { toolCallId: `call_${index}` });
      await repo.markDispatched({ ownerId: OWNER, checkpointId: checkpoint.checkpointId, now: dispatchedAt });
    }
    await expect(repo.reconcileDispatched({ olderThan: at(60_000), now: at(120_000), limit: 1 })).resolves.toBe(1);
    await expect(repo.reconcileDispatched({ olderThan: at(60_000), now: at(120_000) })).resolves.toBe(1);
    await expect(repo.reconcileDispatched({ olderThan: at(60_000), now: at(120_000) })).resolves.toBe(0);
    const phases = (await repo.listForRun({ ownerId: OWNER, runId: "run_ckpt" })).map((row) => row.phase);
    expect(phases).toEqual(["effect_unknown", "effect_unknown", "dispatched"]);
  });
});
