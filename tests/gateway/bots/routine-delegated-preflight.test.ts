import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotToolRequestSchema, type BotToolResult } from "@matrix-os/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { BotRuntimeRegistry, type BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotStateDatabase, insertChat, BOT, NOW, OWNER } from "./bot-state-support.js";

let state: Awaited<ReturnType<typeof createBotStateDatabase>>, home: string;
let binding: BotRuntimeBinding;
const signal = new AbortController().signal;
beforeEach(async () => {
  state = await createBotStateDatabase();
  home = await mkdtemp(join(tmpdir(), "routine-delegated-preflight-"));
  await insertChat(state.db, "chat_delegated");
  await createBotBindingsRepository(state.db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_delegated", now: NOW });
  const task = await createBotTasksRepository(state.db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_delegated", now: NOW });
  binding = { runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId: BOT,
    chatId: "chat_delegated", taskId: task.taskId, runId: "run_delegated", rootFingerprint: "f".repeat(64),
    route: { api: "openai-responses", modelId: "admitted-model", input: ["text"], contextWindow: 8192, maxOutputTokens: 256 },
    accessSourceId: "matrix_chatgpt_plan", subscription: { accountId: "fixture", computerId: "fixture", grantRevision: 1,
      peerId: "00000000-0000-4000-8000-000000000001" }, capabilities: ["routine.propose"], requestClass: "interactive" };
});
afterEach(async () => {
  try { await state?.destroy(); } finally { if (home) await rm(home, { recursive: true, force: true }); }
});
const request = (model = "unadmitted-display-name") => BotToolRequestSchema.parse({ toolCallId: "routine_delegated",
  capability: "routine.propose", args: { name: "Fixture", prompt: "Read synthetic data", schedule: { kind: "interval", everyMs: 60_000 },
    selection: { instanceId: "matrix_chatgpt_plan", model }, authorizedEffects: ["read"] } });

function setup() {
  const result: BotToolResult = { ok: true, content: [{ type: "text", text: "Synthetic delegated pending approval" }] };
  const routine = vi.fn(async () => result), nativeExecute = vi.fn(), cliExecute = vi.fn();
  const routines = { propose: vi.fn(), list: vi.fn(), control: vi.fn() };
  const tools = createBotToolDispatcher({ homePath: home, routines, managedRoutine: { execute: cliExecute },
    nativeTask: { routine, prepare: vi.fn(), execute: nativeExecute } });
  const registry = new BotRuntimeRegistry(); registry.bind(binding);
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected external operation in isolated preflight fixture"); };
  const actions = createBotBrokerActions({ db: state.db, registry, tools, sessions: createBotSessionsRepository(state.db),
    checkpoints: createBotCheckpointsRepository(state.db), runs: { loadRunSpec: unexpected, readImageChunk: unexpected },
    events: { publish: unexpected }, inference: { homePath: home, lifetime: signal, resolveCredentials: unexpected, fetchImpl: unexpected },
    now: () => new Date(NOW) });
  const frame = (tool: ReturnType<typeof request>) => ({ version: 1, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
    runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, runId: binding.runId, action: "bot.tool", tool });
  return { tools, actions, frame, routine, nativeExecute, cliExecute, routines };
}

it("refuses an unadmitted model before native routine/CLI dispatch or an effect checkpoint", async () => {
  const f = setup(), invalid = request();
  await expect(f.tools.prepare!(binding, invalid, signal)).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(f.tools.dispatch(binding, invalid, signal)).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(f.actions.handleFrame(f.frame(invalid))).resolves.toMatchObject({ ok: false, code: "invalid_arguments" });
  expect(f.routine).not.toHaveBeenCalled();
  expect(f.nativeExecute).not.toHaveBeenCalled();
  expect(f.cliExecute).not.toHaveBeenCalled();
  for (const method of Object.values(f.routines)) expect(method).not.toHaveBeenCalled();
  expect(await state.db.selectFrom("bot_tool_checkpoints").selectAll().execute()).toHaveLength(0);
});

it("keeps native delegation for the admitted model and never repeats its effect on a duplicate call", async () => {
  const f = setup(), valid = request(binding.route.modelId);
  await expect(f.actions.handleFrame(f.frame(valid))).resolves.toMatchObject({ ok: true, result: { ok: true } });
  await expect(f.actions.handleFrame(f.frame(valid))).resolves.toMatchObject({ ok: false, code: "denied" });
  expect(f.routine).toHaveBeenCalledTimes(1);
  expect(f.routine).toHaveBeenCalledWith(expect.objectContaining({ runId: binding.runId }), valid, expect.any(AbortSignal));
  expect(f.cliExecute).not.toHaveBeenCalled();
  expect(f.routines.propose).not.toHaveBeenCalled();
  expect(await state.db.selectFrom("bot_tool_checkpoints").select("phase").execute()).toEqual([{ phase: "observed_complete" }]);
});
