import { expect, it, vi } from "vitest";
import type { CanonicalChatSafeError } from "@matrix-os/contracts";
import { createBotRoutineScheduler } from "../../../packages/gateway/src/bots/routine-scheduler.js";
import { CanonicalChatOrchestrationError } from "../../../packages/gateway/src/chat/orchestration-errors.js";
import type { BotRoutine, BotRoutineFire } from "../../../packages/gateway/src/bots/repositories/routines.js";

const NOW = "2026-11-05T12:00:00.000Z";
const PRIVATE = "UNSAFE_PROVIDER /private/account/path token=fixture-private-value";
const routine: BotRoutine = {
  routineId: "rt_aaaaaaaaaaaaaaaaaaaaaaaa", ownerId: "fixture_owner", botId: "bot_aaaaaaaaaaaaaaaaaaaa", chatId: "chat_fixture",
  approvalId: "approval_fixture", authorization: null, revision: 1, status: "active", nextFireAt: NOW, createdAt: NOW, updatedAt: NOW,
  proposal: { name: "Fixture", prompt: "Fixture", schedule: { kind: "interval", everyMs: 60_000 },
    selection: { instanceId: "matrix_chatgpt_plan", model: "fixture" }, authorizedEffects: ["read"] },
};
const fire: BotRoutineFire = { fireId: "fire_aaaaaaaaaaaaaaaaaaaaaaaa", ownerId: routine.ownerId, routineId: routine.routineId,
  taskId: "task_aaaaaaaaaaaaaaaaaaaa", scheduledFor: NOW, status: "claimed", attempts: 0, retryAfter: null,
  failureCode: null, leaseExpiresAt: null, createdAt: NOW, updatedAt: NOW };

function canonical(code: CanonicalChatSafeError["code"] = "authorization_failed") {
  return new CanonicalChatOrchestrationError({ code, safeMessage: PRIVATE, retryable: false }, 503);
}

// The repository is an isolated boundary fixture. The production scheduler owns
// dispatch/catch/settlement; no provider, account, database or real timer is used.
async function tickAndObserve(error: unknown) {
  let dispatched = false;
  const repository = {
    due: vi.fn().mockResolvedValue([]), claim: vi.fn(), get: vi.fn().mockResolvedValue(routine),
    pending: vi.fn(async () => dispatched ? [] : [fire]), recover: vi.fn().mockResolvedValue(0),
    dispatch: vi.fn(async () => { dispatched = true; return { ...fire, status: "dispatched" as const, attempts: 1 }; }),
    finish: vi.fn().mockResolvedValue(true), defer: vi.fn(),
  };
  const run = vi.fn(async () => { throw error; });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const scheduler = createBotRoutineScheduler({ repository, authorize: async () => true, run, now: () => new Date(NOW) });
  try {
    await scheduler.tick(); await scheduler.tick();
    expect(repository.dispatch).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
    expect(repository.defer).not.toHaveBeenCalled();
    expect(repository.finish).toHaveBeenCalledExactlyOnceWith({ ownerId: fire.ownerId, fireId: fire.fireId,
      status: "uncertain", failureCode: "outcome_unknown", now: NOW });
    expect(warn).toHaveBeenCalledOnce();
    return warn.mock.calls[0];
  } finally { await scheduler.stop(); warn.mockRestore(); }
}

it.each(["authorization_failed", "chat_busy", "service_unavailable"] as const)("retains the allowlisted %s code from the real scheduler catch without retrying an uncertain fire", async code => {
  const log = await tickAndObserve(canonical(code));
  expect(log).toEqual(["[bots] routine outcome unavailable", { errorType: "CanonicalChatOrchestrationError", code }]);
  expect(JSON.stringify(log)).not.toContain(PRIVATE);
});

it("never logs canonical name, message, stack, status, cause or arbitrary safe-error fields", async () => {
  const error = canonical(); error.name = PRIVATE; error.stack = PRIVATE;
  Object.assign(error, { cause: { token: PRIVATE }, arbitrary: PRIVATE });
  Object.assign(error.safeError, { safeMessage: PRIVATE, extra: PRIVATE });
  const log = await tickAndObserve(error);
  expect(log).toEqual(["[bots] routine outcome unavailable", { errorType: "CanonicalChatOrchestrationError", code: "authorization_failed" }]);
  expect(JSON.stringify(log)).not.toContain(PRIVATE);
});

it.each([{ label: "missing", code: undefined }, { label: "null", code: null }, { label: "long", code: PRIVATE.repeat(100) },
  { label: "object", code: { private: PRIVATE } }])("omits malformed canonical codes without serializing their payload: $label", async ({ code }) => {
  const error = canonical(); Object.defineProperty(error, "safeError", { value: { code, safeMessage: PRIVATE, retryable: false } });
  const log = await tickAndObserve(error);
  expect(log).toEqual(["[bots] routine outcome unavailable", { errorType: "CanonicalChatOrchestrationError" }]);
  expect(JSON.stringify(log).length).toBeLessThan(200); expect(JSON.stringify(log)).not.toContain(PRIVATE);
});

it.each(["safeError", "code"] as const)("does not invoke a malformed canonical %s getter", async field => {
  const error = canonical(), getter = vi.fn(() => { throw new Error(PRIVATE); });
  if (field === "safeError") Object.defineProperty(error, "safeError", { get: getter });
  else Object.defineProperty(error.safeError, "code", { get: getter });
  const log = await tickAndObserve(error);
  expect(getter).not.toHaveBeenCalled();
  expect(log).toEqual(["[bots] routine outcome unavailable", { errorType: "CanonicalChatOrchestrationError" }]);
});

it.each(["throwing", "revoked"])("settles the same uncertain fire without invoking a %s Proxy safeError payload", async kind => {
  const error = canonical(), trap = vi.fn(() => { throw new Error(PRIVATE); });
  const wrapped = Proxy.revocable({ code: "authorization_failed" }, { getOwnPropertyDescriptor: trap, getPrototypeOf: trap, get: trap });
  if (kind === "revoked") wrapped.revoke();
  Object.defineProperty(error, "safeError", { value: wrapped.proxy });
  expect(await tickAndObserve(error)).toEqual(["[bots] routine outcome unavailable", { errorType: "CanonicalChatOrchestrationError" }]);
  expect(trap).not.toHaveBeenCalled();
});

it.each(["throwing", "revoked"])("settles without inspecting a %s Proxy error input", async kind => {
  const trap = vi.fn(() => { throw new Error(PRIVATE); });
  const wrapped = Proxy.revocable(new Error(PRIVATE), { getPrototypeOf: trap, get: trap });
  if (kind === "revoked") wrapped.revoke();
  expect(await tickAndObserve(wrapped.proxy)).toEqual(["[bots] routine outcome unavailable", { errorType: "UnknownError" }]);
  expect(trap).not.toHaveBeenCalled();
});

it("uses a coarse fallback for a generic Error even when its name impersonates the canonical class", async () => {
  const error = new Error(PRIVATE); error.name = "CanonicalChatOrchestrationError";
  Object.assign(error, { safeError: { code: "authorization_failed", safeMessage: PRIVATE }, token: PRIVATE });
  expect(await tickAndObserve(error)).toEqual(["[bots] routine outcome unavailable", { errorType: "Error" }]);
});

it.each([{ label: "string", error: PRIVATE }, { label: "object", error: { name: PRIVATE, safeError: { code: PRIVATE }, stack: PRIVATE } },
  { label: "null", error: null }])("uses a coarse fallback for a non-Error without copying its fields: $label", async ({ error }) => {
  const log = await tickAndObserve(error);
  expect(log).toEqual(["[bots] routine outcome unavailable", { errorType: "UnknownError" }]);
});
