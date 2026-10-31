import { expect, it, vi } from "vitest";
import { createBotRoutineCanonicalRunner } from "../../../packages/gateway/src/bots/continuations.js";
import { CanonicalChatOrchestrationError } from "../../../packages/gateway/src/chat/orchestration-errors.js";

const routine = { ownerId: "owner_fixture", chatId: "chat_abort_fixture", proposal: { prompt: "Fixture" } };
const fire = { fireId: "fire_" + "a".repeat(24) };
const busy = () => new CanonicalChatOrchestrationError({ code: "chat_busy", safeMessage: "Busy", retryable: true }, 409);

it.each(["outer_lookup", "chat_read", "inner_lookup", "busy"] as const)("starts no new admission after cancellation during %s", async stage => {
  const controller = new AbortController(); let reads = 0;
  const findQueuedAdmission = vi.fn(async () => { reads++; if (reads === (stage === "outer_lookup" ? 1 : stage === "inner_lookup" ? 2 : 0)) controller.abort(); return null; });
  const get = vi.fn(async () => { if (stage === "chat_read") controller.abort(); return { chat: { revision: 1 } } as never; });
  const admitTurn = vi.fn(async () => { if (stage === "busy") { controller.abort(); throw busy(); } return {} as never; });
  const enqueueQueuedTurn = vi.fn(async () => ({} as never));
  const run = createBotRoutineCanonicalRunner({ repository: { findQueuedAdmission, get }, orchestrator: { admitTurn, enqueueQueuedTurn } });
  await expect(run(routine, fire, controller.signal)).resolves.toEqual({ status: "cancelled" });
  expect(admitTurn).toHaveBeenCalledTimes(stage === "busy" ? 1 : 0);
  expect(enqueueQueuedTurn).not.toHaveBeenCalled();
});

it.each(["accepted", "queued", "unknown"] as const)("preserves a late %s admission outcome instead of inventing cancellation", async outcome => {
  const controller = new AbortController(), failure = new Error("Synthetic uncertain admission");
  const admitTurn = vi.fn(async () => {
    if (outcome === "queued") throw busy();
    controller.abort(); if (outcome === "unknown") throw failure;
    return {} as never;
  });
  const enqueueQueuedTurn = vi.fn(async () => { controller.abort(); return {} as never; });
  const run = createBotRoutineCanonicalRunner({ repository: { findQueuedAdmission: vi.fn(async () => null), get: vi.fn(async () => ({ chat: { revision: 1 } }) as never) },
    orchestrator: { admitTurn, enqueueQueuedTurn } });
  if (outcome === "unknown") await expect(run(routine, fire, controller.signal)).rejects.toBe(failure);
  else await expect(run(routine, fire, controller.signal)).resolves.toEqual({ status: "accepted" });
  expect(admitTurn).toHaveBeenCalledTimes(1);
  expect(enqueueQueuedTurn).toHaveBeenCalledTimes(outcome === "queued" ? 1 : 0);
});
