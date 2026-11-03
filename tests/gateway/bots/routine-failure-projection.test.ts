import { expect, it, vi } from "vitest";
import { createMatrixBotChatProviderAdapter } from "../../../packages/gateway/src/bots/chat-adapter.js";
import type { BotTurnResult } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import type { CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";

it.each([true, false])("advertises only available recovery actions for failed turns (scheduled=%s)", async scheduled => {
  for (const result of [{ status: "failed" }, { status: "blocked", blockedReason: "capacity_unavailable" }] as BotTurnResult[]) {
    const selection = { instanceId: "matrix_bot_default", model: "auto" };
    const adapter = createMatrixBotChatProviderAdapter({ stopRuntime: vi.fn(),
      routines: { prepareRun: async () => scheduled ? { backgroundTaskId: "task_projection_fixture",
        selection: { instanceId: "matrix_chatgpt_plan", model: "fixture", options: [{ id: "accountId", value: "fixture" }] }, text: "Fixture" } : undefined,
        completeRun: vi.fn() },
      orchestrator: { start: () => ({ events: (async function* () {})(), result: Promise.resolve(result) }),
        steer: vi.fn(), cancel: vi.fn(), abandon: vi.fn() } as never });
    const events: CanonicalProviderRunEvent[] = [];
    for await (const event of adapter.start({ owner: { type: "personal", ownerId: "owner_fixture" },
      chatId: "chat_projection_fixture", turnId: "cturn_projection_fixture", runId: "run_projection_fixture",
      prompt: "Fixture", parts: [{ type: "text", text: "Fixture" }], selection,
      interactionMode: "default", permissionMode: "default", signal: new AbortController().signal })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed",
      error: { retryable: !scheduled, recoveryActions: scheduled ? [] : ["retry"] } });
  }
});

it("preserves ordinary interactive setup errors for canonical Chat handling", async () => {
  const failure = new Error("Synthetic interactive setup failure");
  const adapter = createMatrixBotChatProviderAdapter({ stopRuntime: vi.fn(),
    routines: { prepareRun: async () => undefined, completeRun: async () => undefined },
    orchestrator: { start: () => { throw failure; }, steer: vi.fn(), cancel: vi.fn(), abandon: vi.fn() } as never });
  const consume = async () => { for await (const _event of adapter.start({ owner: { type: "personal", ownerId: "owner_fixture" },
    chatId: "chat_projection_fixture", turnId: "cturn_projection_fixture", runId: "run_projection_fixture",
    prompt: "Fixture", parts: [{ type: "text", text: "Fixture" }], selection: { instanceId: "matrix_bot_default", model: "auto" },
    interactionMode: "default", permissionMode: "default", signal: new AbortController().signal })) {} };
  await expect(consume()).rejects.toBe(failure);
});

it.each(["prepare", "start", "settlement"] as const)("does not advertise Retry after a recognized scheduled %s failure", async failure => {
  const selection = { instanceId: "matrix_bot_default", model: "auto" };
  const adapter = createMatrixBotChatProviderAdapter({ stopRuntime: vi.fn(),
    routines: { prepareRun: async () => { if (failure === "prepare") throw new Error("Synthetic revoked authority");
      return { backgroundTaskId: "task_projection_fixture", selection: { instanceId: "matrix_chatgpt_plan", model: "fixture", options: [] }, text: "Fixture" }; },
    completeRun: async () => { if (failure === "settlement") throw new Error("Synthetic DB failure"); return failure === "prepare" ? { status: "failed" } : undefined; } },
    orchestrator: { start: () => { throw new Error("Synthetic setup failure"); }, steer: vi.fn(), cancel: vi.fn(), abandon: vi.fn() } as never });
  const events: CanonicalProviderRunEvent[] = [];
  for await (const event of adapter.start({ owner: { type: "personal", ownerId: "owner_fixture" },
    chatId: "chat_projection_fixture", turnId: "cturn_projection_fixture", runId: "run_projection_fixture",
    prompt: "Fixture", parts: [{ type: "text", text: "Fixture" }], selection,
    interactionMode: "default", permissionMode: "default", signal: new AbortController().signal })) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed", error: { retryable: false, recoveryActions: [] } });
});
