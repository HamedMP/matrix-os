import type { BotModelRoute } from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotAdmissionError } from "../../../packages/gateway/src/bots/admission.js";
import { MAX_BOT_ACTIVITY_EVENTS, createMatrixBotChatProviderAdapter } from "../../../packages/gateway/src/bots/chat-adapter.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotRouteError } from "../../../packages/gateway/src/bots/route-resolver.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_botdirect1";
const RUNTIME = `runtime_${"f".repeat(32)}`;
const ROUTE: BotModelRoute = { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 };
const AGENT = {
  id: BOT, name: "Writing Bot", description: "", instructions: "Help the owner revise essays.", archived: false,
  selection: MATRIX_BOT_SELECTION, recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" },
  revision: 1, createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:00.000Z",
};

type RunBotInput = { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string; text?: string } };

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, CHAT);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: "2026-09-27T12:00:00.000Z" });
});
afterEach(async () => destroy());

function setup(options: {
  worker?: (input: RunBotInput, context: { publish(seq: number, event: Record<string, unknown>): Promise<void> }) => Promise<unknown>;
  resolveRoute?: () => Promise<{ route: BotModelRoute; accessSourceId: "matrix_included" }>;
  admit?: () => Promise<never>;
  executorReady?: () => Promise<boolean>;
  cancelDelivered?: boolean;
  activeDeadlineMs?: number;
  cancelGraceMs?: number;
  agent?: Record<string, unknown> | null;
  memory?: string[];
  admitted?: () => Promise<string[]>;
  answerWithMessage?: () => Promise<void>;
} = {}) {
  const registry = new BotRuntimeRegistry();
  const admission = {
    admit: vi.fn(options.admit ?? (async (request: Parameters<typeof registry.bind>[0]) => {
      registry.bind({ ...request, runtimeHandle: RUNTIME, executionGeneration: "3", rootFingerprint: "f".repeat(64) });
      return { runtimeHandle: RUNTIME, executionGeneration: "3", rootFingerprint: "f".repeat(64) };
    }) as never),
    release: vi.fn(async (handle: string) => registry.release(handle)),
  };
  let orchestrator: ReturnType<typeof createBotTaskOrchestrator>;
  const commands: RunBotInput["command"][] = [];
  const runBot = vi.fn(async (input: RunBotInput) => {
    commands.push(input.command);
    if (input.command.kind !== "bot.run") {
      if (input.command.kind === "bot.cancel") {
        const binding = registry.lookupRun({ ...input, runId: input.command.runId })!;
        expect(registry.inferenceSignal(binding)?.aborted).toBe(true);
      }
      return { ok: options.cancelDelivered !== false, reply: {} };
    }
    const binding = registry.lookupRun({ ...input, runId: input.command.runId })!;
    const publish = (seq: number, event: Record<string, unknown>) => orchestrator.eventSink.publish(binding, { seq, event } as never);
    const reply = options.worker
      ? await options.worker(input, { publish })
      : { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 };
    return { ok: true as const, reply };
  });
  const transact = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
  const interactions = createBotInteractionService({ transact });
  orchestrator = createBotTaskOrchestrator({
    bindings: createBotBindingsRepository(db),
    transact,
    interactions: options.answerWithMessage ? { answerWithMessage: options.answerWithMessage } : interactions,
    memory: { admitted: options.admitted ?? (async () => options.memory ?? []) },
    agents: { get: vi.fn(async () => (options.agent === undefined ? AGENT : options.agent) as never) },
    recipes: createBotRecipeCatalog(),
    resolveRoute: options.resolveRoute ?? (async () => ({ route: ROUTE, accessSourceId: "matrix_included" as const })),
    executorReady: options.executorReady,
    admission,
    registry,
    client: { runBot: runBot as never },
    ...(options.activeDeadlineMs ? { activeDeadlineMs: options.activeDeadlineMs } : {}),
    ...(options.cancelGraceMs ? { cancelGraceMs: options.cancelGraceMs } : {}),
  });
  const stopRuntime = vi.fn(async () => undefined);
  const adapter = createMatrixBotChatProviderAdapter({ orchestrator, stopRuntime });
  return { adapter, orchestrator, admission, registry, commands, stopRuntime, interactions };
}

function turn(signal = new AbortController().signal, runId = "run_turn1", text = "Tighten my intro.") {
  return {
    owner: { type: "personal" as const, ownerId: OWNER }, chatId: CHAT, turnId: "cturn_1", runId, prompt: text,
    parts: [{ type: "text" as const, text }], selection: MATRIX_BOT_SELECTION, interactionMode: "default", permissionMode: "default", signal,
  };
}

async function collect(events: AsyncIterable<CanonicalProviderRunEvent>): Promise<CanonicalProviderRunEvent[]> {
  const collected: CanonicalProviderRunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function tasks() {
  return db.selectFrom("bot_tasks").select(["status", "blocked_reason", "run_id"]).execute();
}

describe("bot turns through the matrix_bot adapter", () => {
  it("keeps legacy Automatic routing when an internal caller omits selection", async () => {
    const resolveRoute = vi.fn(async (selection?: unknown) => {
      if (selection !== undefined) throw new BotRouteError("model_unavailable");
      return { route: ROUTE, accessSourceId: "matrix_included" as const };
    });
    const { orchestrator } = setup({ resolveRoute });
    const run = orchestrator.start({ ownerId: OWNER, chatId: CHAT, runId: "run_legacy_auto",
      text: "Hello", signal: new AbortController().signal });
    expect(await run.result).toMatchObject({ status: "completed" });
    expect(resolveRoute).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("advertises the selected native task executor only after fresh Bot authorization with a Matrix-funded coordinator", async () => {
    const executorReady = vi.fn(async () => true);
    const { adapter, orchestrator, admission } = setup({ executorReady, worker: async (input) => {
      const spec = await orchestrator.runSource.loadRunSpec({ runId: input.command.runId } as never);
      expect(spec.capabilities).toContain("agent.task"); expect(spec.route).toEqual(ROUTE);
      return { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 };
    } });
    await collect(adapter.start(turn())); expect(executorReady).toHaveBeenCalledWith(OWNER, BOT);
    expect(admission.admit).toHaveBeenCalledWith(expect.objectContaining({ accessSourceId: "matrix_included", capabilities: expect.arrayContaining(["agent.task"]) }));
  });

  it("blocks a saved executor whose authorization is revoked before coordinator admission", async () => {
    const { adapter, admission, commands } = setup({ executorReady: async () => { throw new Error("Revoked"); } });
    await collect(adapter.start(turn())); expect(admission.admit).not.toHaveBeenCalled(); expect(commands).toEqual([]);
    expect(await tasks()).toEqual([expect.objectContaining({ status: "blocked", blocked_reason: "policy_denied" })]);
  });

  it("runs one turn in the bot workload and projects its events onto Chat", async () => {
    const { adapter, orchestrator, admission, commands } = setup({
      worker: async (input, { publish }) => {
        const spec = await orchestrator.runSource.loadRunSpec({ runId: input.command.runId } as never);
        expect(spec).toMatchObject({ route: ROUTE, turn: { kind: "prompt", text: "Tighten my intro." }, limits: { maxToolActions: 60 } });
        // Only tools the broker serves today reach the worker.
        expect(spec.capabilities).toEqual(["interaction.create", "memory.search", "memory.propose", "artifact.read", "artifact.write"]);
        expect(spec.systemPrompt).toContain("Help the owner revise essays.");
        await publish(0, { type: "activity", label: "Reading your draft", state: "started" });
        await publish(1, { type: "tool_progress", toolCallId: "toolu 01/weird", capability: "artifact.write", phase: "started" });
        await publish(2, { type: "tool_progress", toolCallId: "toolu 01/weird", capability: "artifact.write", phase: "completed" });
        await publish(3, { type: "assistant_delta", text: "x".repeat(9_000) });
        return { runId: input.command.runId, status: "completed", toolActions: 1, sessionRevision: 2 };
      },
    });
    const events = await collect(adapter.start(turn()));
    expect(events.filter((event) => event.type === "state.updated")).toEqual([
      { type: "state.updated", state: { taskId: expect.stringMatching(/^task_/) } },
      { type: "state.updated", state: { taskId: expect.stringMatching(/^task_/), runtimeHandle: RUNTIME, executionGeneration: "3" } },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.activity", kind: "phase", label: "Reading your draft", status: "running" }));
    const progress = events.filter((event) => event.type === "tool.progress");
    expect(progress.map((event) => event.type === "tool.progress" && event.status)).toEqual(["running", "completed"]);
    expect(progress[0]).toMatchObject({ label: "Saving a file", toolCallId: expect.stringMatching(/^tool_[a-f0-9]{32}$/) });
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => event.type === "assistant.delta" && event.delta.length)).toEqual([4_000, 4_000, 1_000]);
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    expect(commands).toEqual([{ version: 1, kind: "bot.run", runId: "run_turn1" }]);
    expect(admission.release).toHaveBeenCalledWith(RUNTIME);
    await expect(tasks()).resolves.toEqual([{ status: "completed", blocked_reason: null, run_id: "run_turn1" }]);
    // The run is gone once finished: a late frame is stale.
    await expect(orchestrator.runSource.loadRunSpec({ runId: "run_turn1" } as never)).rejects.toMatchObject({ code: "stale_generation" });
  });

  it("ends the run when the bot waits for a person, and keeps the task waiting", async () => {
    const { adapter } = setup({ worker: async (input) => ({ runId: input.command.runId, status: "waiting_person", toolActions: 0, sessionRevision: 1 }) });
    const events = await collect(adapter.start(turn()));
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "waiting_person" })]);
  });

  it("continues the waiting task with the owner's next message, answering its open question", async () => {
    const worker = vi.fn(async (input: RunBotInput) => ({ runId: input.command.runId, status: "waiting_person", toolActions: 0, sessionRevision: 1 }));
    const { adapter, interactions, orchestrator } = setup({ worker, memory: ["(preference) Keep it short."] });
    await collect(adapter.start(turn()));
    const [task] = await db.selectFrom("bot_tasks").selectAll().execute();
    // The bot asked something before its turn ended.
    await interactions.createFromTool({
      runtimeHandle: RUNTIME, executionGeneration: "3", ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task!.task_id, runId: "run_turn1",
      rootFingerprint: "f".repeat(64), route: ROUTE, accessSourceId: "matrix_included", capabilities: ["interaction.create"], requestClass: "interactive",
    }, { blocking: true, payload: { kind: "question", questions: [{ questionId: "q1", header: "Tone", question: "Formal or casual?", allowOther: true, secret: false }] } });
    worker.mockImplementationOnce(async (input) => {
      const spec = await orchestrator.runSource.loadRunSpec({ runId: input.command.runId } as never);
      expect(spec.systemPrompt).toContain("- (preference) Keep it short.");
      return { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 2 };
    });
    await collect(adapter.start(turn(undefined, "run_turn2", "Casual, please.")));
    // Same task, now completed; the question was answered by the reply.
    await expect(tasks()).resolves.toEqual([{ status: "completed", blocked_reason: null, run_id: "run_turn2" }]);
    const [question] = await db.selectFrom("bot_interactions").select(["status", "resolution"]).execute();
    expect(question).toMatchObject({ status: "resolved" });
    expect(JSON.stringify(question!.resolution)).toContain("Casual, please.");
    const events = await db.selectFrom("chat_outbox").select(["event_type", "payload"]).where("chat_id", "=", CHAT).orderBy("cursor").execute();
    expect(events.map((row) => row.event_type)).toEqual([
      "bot.task.updated", "bot.task.updated", "interaction.requested", "bot.task.updated", "interaction.resolved", "bot.task.updated",
    ]);
    // Events carry IDs and allowlisted state only.
    expect(JSON.stringify(events)).not.toContain("Casual");
  });

  it("fails the task when loading admitted memory fails after it starts", async () => {
    const { adapter, admission } = setup({ admitted: async () => { throw new Error("memory unavailable"); } });
    const events = await collect(adapter.start(turn()));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    expect(admission.admit).not.toHaveBeenCalled();
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("fails a continued task when recording its answer fails", async () => {
    const { adapter, admission } = setup({
      worker: async (input) => ({ runId: input.command.runId, status: "waiting_person", toolActions: 0, sessionRevision: 1 }),
      answerWithMessage: async () => { throw new Error("answer unavailable"); },
    });
    await collect(adapter.start(turn()));
    const events = await collect(adapter.start(turn(undefined, "run_turn2", "My answer.")));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    expect(admission.admit).toHaveBeenCalledTimes(1);
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed", run_id: "run_turn2" })]);
  });

  it("keeps the task waiting when the run ended with a request to the owner still open", async () => {
    const { adapter, interactions } = setup({
      worker: async (input) => {
        const [task] = await db.selectFrom("bot_tasks").select("task_id").execute();
        // The gateway asked the owner on the bot's behalf; the worker simply finished its turn.
        await interactions.createFromTool({
          runtimeHandle: RUNTIME, executionGeneration: "3", ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task!.task_id, runId: input.command.runId,
          rootFingerprint: "f".repeat(64), route: ROUTE, accessSourceId: "matrix_included", capabilities: ["interaction.create"], requestClass: "interactive",
        }, { blocking: true, payload: { kind: "question", questions: [{ questionId: "q1", header: "Account", question: "Which one?", allowOther: true, secret: false }] } });
        return { runId: input.command.runId, status: "completed", toolActions: 1, sessionRevision: 1 };
      },
    });
    await collect(adapter.start(turn()));
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "waiting_person" })]);
  });

  it("blocks without starting a runtime when no model or workspace is available", async () => {
    const noModel = setup({ resolveRoute: async () => { throw new BotRouteError("model_unavailable"); } });
    const events = await collect(noModel.adapter.start(turn()));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed", error: { code: "model_unavailable" } });
    expect(noModel.admission.admit).not.toHaveBeenCalled();

    const noRoot = setup({ admit: async () => { throw new BotAdmissionError("root_changed"); } });
    const second = await collect(noRoot.adapter.start(turn(undefined, "run_turn2")));
    expect(second.at(-1)).toMatchObject({ outcome: "failed", error: { code: "resource_unavailable" } });
    expect((await tasks()).map((task) => task.blocked_reason).sort()).toEqual(["model_unavailable", "root_unavailable"]);
  });

  it("never runs a chat that is not a live bot's direct chat", async () => {
    const { adapter, admission } = setup({ agent: null });
    const events = await collect(adapter.start(turn()));
    expect(events.at(-1)).toMatchObject({ outcome: "failed", error: { code: "run_failed" } });
    expect(admission.admit).not.toHaveBeenCalled();
    await expect(tasks()).resolves.toEqual([]);
  });

  it("cancels a running turn through the worker, and stops a worker that does not take the cancel", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const controller = new AbortController();
    const { adapter, commands, admission } = setup({ worker: (input) => new Promise((resolve) => { finish = () => resolve({ runId: input.command.runId, status: "cancelled", toolActions: 0, sessionRevision: 1 }); }) });
    const running = collect(adapter.start(turn(controller.signal)));
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    controller.abort();
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toEqual(["bot.run", "bot.cancel"]));
    finish(undefined);
    expect((await running).at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(admission.release).toHaveBeenCalledTimes(1);

    const stubborn = setup({ cancelDelivered: false, worker: () => new Promise(() => undefined) });
    const aborted = new AbortController();
    const stuck = collect(stubborn.adapter.start(turn(aborted.signal, "run_turn3")));
    await vi.waitFor(() => expect(stubborn.commands).toHaveLength(1));
    aborted.abort();
    // The worker ignored the cancel, so its runtime is stopped outright.
    await vi.waitFor(() => expect(stubborn.admission.release).toHaveBeenCalledWith(RUNTIME));
    void stuck;
  });

  it("cancels the bot when Chat stops reading the turn early", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { adapter, commands } = setup({
      worker: async (input, { publish }) => {
        await publish(0, { type: "assistant_delta", text: "Working" });
        return new Promise((resolve) => { finish = () => resolve({ runId: input.command.runId, status: "cancelled", toolActions: 0, sessionRevision: 1 }); });
      },
    });
    const events = adapter.start(turn())[Symbol.asyncIterator]();
    await events.next();
    await events.next();
    const stopping = events.return!(undefined);
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toEqual(["bot.run", "bot.cancel"]));
    finish(undefined);
    await stopping;
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it("stops a turn at the active-work deadline and blocks the task", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { adapter, commands } = setup({
      activeDeadlineMs: 30,
      worker: (input) => new Promise((resolve) => { finish = () => resolve({ runId: input.command.runId, status: "cancelled", toolActions: 3, sessionRevision: 1 }); }),
    });
    const running = collect(adapter.start(turn()));
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toContain("bot.cancel"));
    finish(undefined);
    expect((await running).at(-1)).toMatchObject({ outcome: "failed", error: { code: "run_failed", safeMessage: expect.stringContaining("time limit") } });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "blocked", blocked_reason: "deadline_reached" })]);
  });

  it("stops a worker that took the cancel but did not end its run", async () => {
    const aborted = new AbortController();
    const { adapter, commands, admission } = setup({ cancelGraceMs: 30, worker: () => new Promise(() => undefined) });
    const running = collect(adapter.start(turn(aborted.signal)));
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    aborted.abort();
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toEqual(["bot.run", "bot.cancel"]));
    await vi.waitFor(() => expect(admission.release).toHaveBeenCalledWith(RUNTIME));
    void running;
  });

  it("blocks a task whose run needs more time after the deadline, but keeps a reply that finished", async () => {
    for (const [status, expected] of [["waiting_person", { status: "blocked", blocked_reason: "deadline_reached" }], ["completed", { status: "completed", blocked_reason: null }]] as const) {
      await db.deleteFrom("bot_tasks").execute();
      let finish: (value: unknown) => void = () => undefined;
      const { adapter, commands } = setup({
        activeDeadlineMs: 30,
        worker: (input) => new Promise((resolve) => { finish = () => resolve({ runId: input.command.runId, status, toolActions: 1, sessionRevision: 1 }); }),
      });
      const running = collect(adapter.start(turn(undefined, `run_late_${status}`)));
      await vi.waitFor(() => expect(commands.map((command) => command.kind)).toContain("bot.cancel"));
      finish(undefined);
      await running;
      await expect(tasks()).resolves.toEqual([expect.objectContaining(expected)]);
    }
  });

  it("keeps a chatty turn within Chat's activity budget while the reply still streams", async () => {
    const { adapter } = setup({
      worker: async (input, { publish }) => {
        let seq = 0;
        for (let index = 0; index < 250; index += 1) {
          await publish(seq++, { type: "tool_progress", toolCallId: `call_${index}`, capability: "artifact.read", phase: "started" });
          await publish(seq++, { type: "tool_progress", toolCallId: `call_${index}`, capability: "artifact.read", phase: "completed" });
        }
        await publish(seq++, { type: "assistant_delta", text: "Done." });
        return { runId: input.command.runId, status: "completed", toolActions: 60, sessionRevision: 1 };
      },
    });
    const events = await collect(adapter.start(turn()));
    const activities = events.filter((event) => event.type === "tool.progress" || event.type === "agent.activity");
    expect(activities).toHaveLength(MAX_BOT_ACTIVITY_EVENTS);
    expect(activities.at(-1)).toMatchObject({ type: "agent.activity", label: "More steps were not shown" });
    expect(events).toContainEqual({ type: "assistant.delta", delta: "Done." });
  });

  it("relays steering to the running worker only", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { adapter, commands } = setup({ worker: (input) => new Promise((resolve) => { finish = () => resolve({ runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 }); }) });
    const running = collect(adapter.start(turn()));
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    await adapter.steer!({ owner: { type: "personal", ownerId: OWNER }, chatId: CHAT, runId: "run_turn1", turnId: "cturn_2", clientRequestId: "req_steer", prompt: "Shorter.", parts: [{ type: "text", text: "Shorter." }] });
    expect(commands.at(-1)).toEqual({ version: 1, kind: "bot.steer", runId: "run_turn1", text: "Shorter." });
    finish(undefined);
    await running;
    await expect(adapter.steer!({ owner: { type: "personal", ownerId: OWNER }, chatId: CHAT, runId: "run_turn1", turnId: "cturn_3", clientRequestId: "req_late", prompt: "Late", parts: [{ type: "text", text: "Late" }] }))
      .rejects.toThrow();
  });

  it("closes a run the previous process lost: stops its runtime, fails its task, replays nothing", async () => {
    const { adapter, stopRuntime, commands } = setup();
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: "2026-09-27T12:00:00.000Z" });
    await createBotTasksRepository(db).transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: task.revision, to: "running", runId: "run_lost", now: "2026-09-27T12:00:01.000Z" });
    const recovered = await adapter.recover!({
      owner: { type: "personal", ownerId: OWNER }, runId: "run_lost", signal: new AbortController().signal,
      state: { taskId: task.taskId, runtimeHandle: RUNTIME, executionGeneration: "3" },
    });
    expect(recovered).toEqual({ outcome: "failed", messages: [] });
    expect(stopRuntime).toHaveBeenCalledWith(RUNTIME);
    expect(commands).toEqual([]);
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed" })]);
  });
});
