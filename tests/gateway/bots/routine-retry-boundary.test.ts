import { expect, it, vi } from "vitest";
import { activated, admitFixture, CHAT, data } from "./routine-authorization-support.js";
import { OWNER } from "./bot-state-support.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createMatrixBotChatProviderAdapter } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";

async function failedTurn(status: "failed" | "uncertain", requestId?: string) {
  const fixture = await activated(), identity = await admitFixture(fixture.f.fireId, requestId);
  const context = (await identity.repository.getTurnRunContext(identity.owner, CHAT, "cturn_routine_fixture"))!;
  await fixture.repo.finish({ ownerId: OWNER, fireId: fixture.f.fireId, status, now: fixture.at });
  await identity.repository.finishRun(identity.owner, { chatId: CHAT, runId: identity.runId, outcome: "failed", completedAt: fixture.at });
  return { ...fixture, ...identity, context };
}

it.each(["failed", "uncertain"] as const)("refuses an ordinary Chat retry of a %s scheduled turn before provider lookup or new run writes", async status => {
  const f = await failedTurn(status);
  const getCatalog = vi.fn(async () => { throw new Error("Synthetic provider boundary reached"); });
  const orchestrator = new CanonicalChatOrchestrator({ repository: f.repository,
    catalog: { getCatalog }, adapters: new CanonicalChatProviderRegistry([]) });
  const before = await f.repository.exportChat(f.owner, CHAT);
  try {
    await expect(orchestrator.retryTurn({ userId: OWNER, source: "jwt" }, f.owner, CHAT, f.context.turn.id,
      { clientRequestId: "req_manual_retry", baseRevision: before!.chat.chat.revision }))
      .rejects.toMatchObject({ status: 409, safeError: { code: "run_unavailable", retryable: false, recoveryActions: [] } });
    expect(getCatalog).not.toHaveBeenCalled();
    expect(await f.repository.exportChat(f.owner, CHAT)).toEqual(before);
    expect((await f.repo.getFire(OWNER, f.f.fireId))?.status).toBe(status);
  } finally { await orchestrator.close(); }
});

it.each(["failed", "uncertain"] as const)("fences an already-admitted %s scheduled retry before it can become an interactive Bot task", async status => {
  const f = await failedTurn(status);
  const retried = await f.repository.admitRetry(f.owner, { chatId: CHAT, turnId: f.context.turn.id,
    clientRequestId: "req_manual_retry", baseRevision: (await f.repository.get(f.owner, CHAT))!.chat.revision,
    run: { ...f.context.latestRun, id: "run_manual_retry", attempt: 2, status: "accepted" } });
  expect(retried.run.attempt).toBe(2);
  const start = vi.fn(() => { throw new Error("Unexpected interactive Bot task"); });
  const execution = createBotRoutineExecution({ db: data.db, approvals: f.service, now: () => new Date(f.at) });
  const adapter = createMatrixBotChatProviderAdapter({ routines: execution, stopRuntime: vi.fn(),
    orchestrator: { start, steer: vi.fn(), cancel: vi.fn(), abandon: vi.fn() } as never });
  const consume = async () => {
    const events = [];
    for await (const _event of adapter.start({ owner: f.owner, chatId: CHAT, runId: retried.run.id,
      turnId: f.context.turn.id, prompt: "Synthetic retry", parts: [{ type: "text", text: "Synthetic retry" }],
      selection: f.context.latestRun.selection, interactionMode: "default", permissionMode: "default",
      signal: new AbortController().signal })) events.push(_event);
    return events;
  };
  expect((await consume()).at(-1)).toMatchObject({ type: "run.completed", outcome: "failed", error: { retryable: false, recoveryActions: [] } });
  expect(start).not.toHaveBeenCalled();
  expect((await f.repo.getFire(OWNER, f.f.fireId))?.status).toBe(status);
});

it("leaves an ordinary interactive Bot retry eligible for its existing admission and execution path", async () => {
  const f = await failedTurn("failed", "req_interactive_fixture");
  const retried = await f.repository.admitRetry(f.owner, { chatId: CHAT, turnId: f.context.turn.id,
    clientRequestId: "req_manual_retry", baseRevision: (await f.repository.get(f.owner, CHAT))!.chat.revision,
    run: { ...f.context.latestRun, id: "run_manual_retry", attempt: 2, status: "accepted" } });
  const execution = createBotRoutineExecution({ db: data.db, approvals: f.service });
  await expect(execution.prepareRun({ owner: f.owner, chatId: CHAT, runId: retried.run.id })).resolves.toBeUndefined();
});
