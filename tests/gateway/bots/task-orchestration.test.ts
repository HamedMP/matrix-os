import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { runCommandFromSpec } from "../../../packages/bot-runtime/src/worker.js";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import type { CanonicalChatModelSelection, BotModelRoute } from "@matrix-os/contracts";
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
import type { BotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotExecutorReadiness } from "../../../packages/gateway/src/bots/executor-readiness.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

// Reset must release fixture closures instead of restoring an original implementation.
const fixtureMock = <Args extends unknown[], Result>(implementation: (...args: Args) => Result) => vi.fn<(...args: Args) => Result>().mockImplementation(implementation);

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath), open: vi.fn(actual.open) };
});

const CHAT = "chat_botdirect1";
const RUNTIME = `runtime_${"f".repeat(32)}`;
const ROUTE: BotModelRoute = { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 };
const AGENT = {
  id: BOT, name: "Writing Bot", description: "", instructions: "Help the owner revise essays.", archived: false,
  selection: MATRIX_BOT_SELECTION, recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" },
  revision: 1, createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:00.000Z",
};

type RunBotInput = { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string; text?: string }; signal?: AbortSignal };

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, CHAT);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: "2026-09-27T12:00:00.000Z" });
});
afterEach(async () => { vi.unstubAllEnvs(); try { await destroy(); } finally { vi.resetAllMocks(); vi.restoreAllMocks(); } });

function setup(options: {
  homePath?: string;
  routineTools?: boolean;
  inputHistory?: Parameters<typeof createBotTaskOrchestrator>[0]["inputHistory"];
  resolveGroupRoute?: Parameters<typeof createBotTaskOrchestrator>[0]["resolveGroupRoute"];
  worker?: (input: RunBotInput, context: { publish(seq: number, event: Record<string, unknown>): Promise<void> }) => Promise<unknown>;
  resolveRoute?: (selection?: CanonicalChatModelSelection) => Promise<import("../../../packages/gateway/src/bots/route-resolver.js").ResolvedBotRoute>;
  admit?: () => Promise<never>;
  executorReady?: (ownerId: string, botId: string) => Promise<boolean>;
  cancelDelivered?: boolean;
  steerReply?: Record<string, unknown>;
  cancelGraceMs?: number;
  agent?: Record<string, unknown> | null;
  resolveProcedure?: Parameters<typeof createBotTaskOrchestrator>[0]["resolveProcedure"];
  memory?: string[];
  admitted?: () => Promise<string[]>;
  resolveGroupRun?: (input: { ownerId: string; chatId: string; runId: string }) => Promise<unknown>;
  authorizeGroup?: import("../../../packages/gateway/src/bots/runtime-registry.js").GroupBotAuthorizer;
  answerWithMessage?: () => Promise<void>;
  assertSource?: () => Promise<void>;
  transact?: (base: BotStateTransactions) => BotStateTransactions;
} = {}) {
  const registry = new BotRuntimeRegistry();
  const lifecycle: string[] = [];
  let renewalFailure: ((error: unknown) => void) | undefined;
  const stopRenewal = fixtureMock(async () => { lifecycle.push("renewal.stop"); });
  const admission = {
    admit: fixtureMock(options.admit ?? (async (request: Parameters<typeof registry.bind>[0]) => {
      const { expectedRootFingerprint: _fingerprint, signal: _signal, ...runtimeRequest } = request as typeof request & { expectedRootFingerprint?: string; signal?: AbortSignal };
      registry.bind({ ...runtimeRequest, ...(request.group ? { group: { scopeId: "scope-company", actorId: "user_member", authEpoch: 4, authorityGeneration: 1, authorityRuntimeId: "owner-runtime" } } : {}), runtimeHandle: RUNTIME, executionGeneration: "3", rootFingerprint: "f".repeat(64) });
      return { runtimeHandle: RUNTIME, executionGeneration: "3", rootFingerprint: "f".repeat(64) };
    }) as never),
    release: fixtureMock(async (handle: string) => { lifecycle.push("runtime.release"); registry.release(handle); }),
    startRenewal: fixtureMock((binding: unknown, onFailure: (error: unknown) => void) => {
      renewalFailure = onFailure;
      return { stop: stopRenewal };
    }),
  };
  let orchestrator: ReturnType<typeof createBotTaskOrchestrator>;
  const commands: RunBotInput["command"][] = [];
  const runBot = fixtureMock(async (input: RunBotInput) => {
    commands.push(input.command);
    if (input.command.kind !== "bot.run") {
      if (input.command.kind === "bot.cancel") {
        lifecycle.push("worker.cancel");
        const binding = registry.lookupRun({ ...input, runId: input.command.runId })!;
        expect(registry.inferenceSignal(binding)?.aborted).toBe(true);
      }
      return { ok: options.cancelDelivered !== false, reply: input.command.kind === "bot.steer" ? options.steerReply ?? { acknowledged: true } : {} };
    }
    const binding = registry.lookupRun({ ...input, runId: input.command.runId })!;
    const publish = (seq: number, event: Record<string, unknown>) => orchestrator.eventSink.publish(binding, { seq, event } as never);
    const reply = options.worker
      ? await options.worker(input, { publish })
      : { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 };
    return { ok: true as const, reply };
  });
  const baseTransact = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
  const transact = options.transact?.(baseTransact) ?? baseTransact;
  const interactions = createBotInteractionService({ transact });
  orchestrator = createBotTaskOrchestrator({
    homePath: options.homePath, expectedOwnerId: OWNER, routineTools: options.routineTools,
    assertSource: options.assertSource,
    inputHistory: options.inputHistory,
    bindings: createBotBindingsRepository(db),
    transact,
    interactions: options.answerWithMessage ? { answerWithMessage: options.answerWithMessage } : interactions,
    memory: { admitted: options.admitted ?? (async () => options.memory ?? []) },
    agents: { get: fixtureMock(async () => (options.agent === undefined ? AGENT : options.agent) as never) },
    recipes: createBotRecipeCatalog(),
    resolveProcedure: options.resolveProcedure,
    resolveGroupRoute: options.resolveGroupRoute ?? (options.resolveGroupRun ? (async () => ({ route: ROUTE, accessSourceId: "matrix_included" as const })) : undefined),
    resolveRoute: options.resolveRoute ?? (async () => ({ route: ROUTE, accessSourceId: "matrix_included" as const })),
    executorReady: options.executorReady,
    admission,
    resolveGroupRun: options.resolveGroupRun as never,
    authorizeGroup: options.authorizeGroup,
    registry,
    client: { runBot: runBot as never },
    ...(options.cancelGraceMs ? { cancelGraceMs: options.cancelGraceMs } : {}),
  });
  const stopRuntime = fixtureMock(async () => undefined);
  const adapter = createMatrixBotChatProviderAdapter({ orchestrator, stopRuntime });
  return {
    adapter, orchestrator, admission, registry, commands, stopRuntime, interactions, lifecycle, stopRenewal,
    failRenewal(error: unknown = new Error("lease unavailable")) {
      if (!renewalFailure) throw new Error("runtime renewal was not started");
      renewalFailure(error);
    },
  };
}

function turn(signal = new AbortController().signal, runId = "run_turn1", text = "Tighten my intro.") {
  return {
    owner: { type: "personal" as const, ownerId: OWNER }, chatId: CHAT, turnId: "cturn_1", runId, prompt: text,
    parts: [{ type: "text" as const, text }], selection: MATRIX_BOT_SELECTION, interactionMode: "default", permissionMode: "default", signal,
  };
}

function directTurn(orchestrator: ReturnType<typeof createBotTaskOrchestrator>, signal = new AbortController().signal) {
  return orchestrator.start({ ownerId: OWNER, chatId: CHAT, runId: "run_turn1", text: "Tighten my intro.",
    parts: turn().parts, selection: MATRIX_BOT_SELECTION, signal });
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
  it("enforces the trusted runtime generation ceiling through normal canonical Bot admission", async () => {
    vi.stubEnv("MATRIX_BOT_MAX_INFERENCE_CALLS", "12");
    const provider = fauxProvider({ models: [{ id: "faux-budget", input: ["text"], contextWindow: 128_000, maxTokens: 8192 }] });
    provider.setResponses([
      ...Array.from({ length: 14 }, (_, index) => fauxAssistantMessage(fauxToolCall("missing_tool", {}, { id: `missing_${index}` }), { stopReason: "toolUse" })),
      fauxAssistantMessage(fauxText("Must not run.")),
    ]);
    const stream = vi.spyOn(provider.provider, "streamSimple");
    const broker = {
      loadSession: async () => ({ revision: 1, needsRecompaction: false, messages: [{ role: "user", content: "Remember the first stage.", timestamp: 1 }] }),
      saveSession: async () => ({ revision: 2 }),
      tool: async () => ({ ok: true as const, content: [{ type: "text" as const, text: "ok" }] }),
      event: async () => {},
    };
    const context = setup({ worker: async input => {
      const binding = context.registry.lookupRun({ ...input, runId: input.command.runId })!;
      const spec = await context.orchestrator.runSource.loadRunSpec(binding);
      expect(spec.limits).toEqual({ maxToolActions: 60, maxInferenceCalls: 12 });
      expect(spec.route.maxOutputTokens).toBe(8192);
      expect(spec.capabilities).toContain("artifact.write");
      const command = runCommandFromSpec(input.command.runId, spec, []);
      return runBotTurn({ command, broker, bridgeOrigin: "http://127.0.0.1:41000", route: { provider: provider.provider, model: provider.getModel() } });
    } });
    const events = await collect(context.adapter.start(turn()));
    expect(stream).toHaveBeenCalledTimes(12);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    expect(stream.mock.calls.every(([, , options]) => options?.maxRetries === 0 && options?.maxTokens === 8192)).toBe(true);
  });

  it.each(["", "0", "-1", "1.5", "64", "12oops", " 12", "01"])("refuses invalid trusted inference configuration %j before admitting a run", value => {
    vi.stubEnv("MATRIX_BOT_MAX_INFERENCE_CALLS", value);
    expect(() => setup()).toThrow();
  });

  it("preserves the owner API binding through recipe task admission and broker inference", async () => {
    const generation = "e16625fe-cad7-4983-a9db-e808bbf104cc";
    const selection = { instanceId: "matrix_anthropic_api", model: ROUTE.modelId,
      options: [{ id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: generation }] };
    const anthropicApi = { connectionRevision: 3, credentialGeneration: generation };
    const resolveRoute = fixtureMock(async (selected?: CanonicalChatModelSelection) => {
      expect(selected).toEqual(selection);
      return { route: ROUTE, accessSourceId: "owner_anthropic_key" as const, anthropicApi };
    });
    const { forwardBotInference } = await import("../../../packages/gateway/src/bots/broker-inference.js");
    const fetcher = fixtureMock<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
    const authority = { observe: vi.fn(), resolve: vi.fn(), credential: fixtureMock(async () => "synthetic-owner-key"), revalidate: fixtureMock(async () => true) };
    const { adapter, admission, registry } = setup({ agent: { ...AGENT, selection }, resolveRoute, worker: async input => {
      const binding = registry.lookupRun({ ...input, runId: input.command.runId })!;
      expect(binding.anthropicApi).toEqual(anthropicApi);
      for (let frame = 0; frame < 2; frame++) {
        const result = await forwardBotInference({ version: 1, requestId: crypto.randomUUID(), runtimeHandle: RUNTIME,
          executionGeneration: "3", action: "inference.messages", path: "/v1/messages?beta=true", method: "POST", headers: {},
          body: JSON.stringify({ model: ROUTE.modelId, stream: true, messages: [] }) }, binding,
          modelId => registry.authorize({ ...binding, modelId, action: "inference.messages" }),
          { homePath: "/unused", matrixAnthropic: authority, fetchImpl: fetcher, lifetime: new AbortController().signal,
            resolveCredentials: async () => { throw new Error("No ambient or funded fallback"); } });
        expect(result.ok).toBe(true);
      }
      return { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 };
    } });
    const events = await collect(adapter.start({ ...turn(), selection: { ...selection, instanceId: "matrix_bot_default" } }));
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    expect(admission.admit).toHaveBeenCalledWith(expect.objectContaining({ accessSourceId: "owner_anthropic_key", anthropicApi }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) expect(new Headers(call[1]?.headers).get("x-api-key")).toBe("synthetic-owner-key");
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("records an ordinary invalid coordinator as a blocked model task", async () => {
    const resolveRoute = vi.fn();
    const { orchestrator, admission } = setup({ resolveRoute });
    const handle = orchestrator.start({ ownerId: OWNER, chatId: CHAT, runId: "run_invalid_coordinator",
      text: "Hello", selection: { instanceId: "matrix_anthropic_api", model: ROUTE.modelId },
      signal: new AbortController().signal });
    expect(await handle.result).toEqual({ status: "blocked", blockedReason: "model_unavailable" });
    expect(await tasks()).toEqual([expect.objectContaining({ status: "blocked", blocked_reason: "model_unavailable", run_id: "run_invalid_coordinator" })]);
    expect(resolveRoute).not.toHaveBeenCalled();
    expect(admission.admit).not.toHaveBeenCalled();
  });

  it("keeps the normal sixty-tool spec when no runtime generation ceiling is configured", async () => {
    vi.stubEnv("MATRIX_BOT_MAX_INFERENCE_CALLS", undefined);
    const context = setup({ worker: async input => {
      const binding = context.registry.lookupRun({ ...input, runId: input.command.runId })!;
      const spec = await context.orchestrator.runSource.loadRunSpec(binding);
      expect(spec.limits).toEqual({ maxToolActions: 60 });
      expect(spec.route.maxOutputTokens).toBe(8192);
      return { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 };
    } });
    expect((await collect(context.adapter.start(turn()))).at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  });

  it("keeps legacy Automatic routing when an internal caller omits selection", async () => {
    const resolveRoute = fixtureMock(async (selection?: unknown) => {
      if (selection !== undefined) throw new BotRouteError("model_unavailable");
      return { route: ROUTE, accessSourceId: "matrix_included" as const };
    });
    const { orchestrator } = setup({ resolveRoute });
    const run = orchestrator.start({ ownerId: OWNER, chatId: CHAT, runId: "run_legacy_auto",
      text: "Hello", signal: new AbortController().signal });
    expect(await run.result).toMatchObject({ status: "completed" });
    expect(resolveRoute).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("runs shared Preview coordinator tools without consulting the host owner's native executor", async () => {
    const execution = fixtureMock(async () => { throw new Error("foreign native owner"); });
    const admit = fixtureMock(async () => { throw new Error("foreign native owner"); });
    const executorReady = createBotExecutorReadiness({ runtimeOwnerId: "different_host_owner", computerId: "preview", nativeTasks: true, connections: { execution, admit } });
    const { adapter, orchestrator } = setup({ executorReady, worker: async (input) => {
      const spec = await orchestrator.runSource.loadRunSpec({ runId: input.command.runId, ownerId: OWNER, chatId: CHAT, runtimeHandle: RUNTIME, executionGeneration: "3" } as never);
      expect(spec.capabilities).not.toContain("agent.task");
      expect(spec.capabilities).toContain("artifact.write");
      return { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 };
    } });
    const events = await collect(adapter.start(turn()));
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "completed" })]);
    expect(execution).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("advertises the selected native task executor only after fresh Bot authorization with a Matrix-funded coordinator", async () => {
    const executorReady = fixtureMock(async () => true);
    const { adapter, orchestrator, admission } = setup({ executorReady, worker: async (input) => {
      const spec = await orchestrator.runSource.loadRunSpec({ runId: input.command.runId, ownerId: OWNER, chatId: CHAT, runtimeHandle: RUNTIME, executionGeneration: "3" } as never);
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
        const spec = await orchestrator.runSource.loadRunSpec({ runId: input.command.runId, ownerId: OWNER, chatId: CHAT, runtimeHandle: RUNTIME, executionGeneration: "3" } as never);
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
    const worker = fixtureMock(async (input: RunBotInput) => ({ runId: input.command.runId, status: "waiting_person", toolActions: 0, sessionRevision: 1 }));
    const { adapter, interactions, orchestrator } = setup({ worker, memory: ["(preference) Keep it short."] });
    await collect(adapter.start(turn()));
    const [task] = await db.selectFrom("bot_tasks").selectAll().execute();
    // The bot asked something before its turn ended.
    await interactions.createFromTool({
      runtimeHandle: RUNTIME, executionGeneration: "3", ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task!.task_id, runId: "run_turn1",
      rootFingerprint: "f".repeat(64), route: ROUTE, accessSourceId: "matrix_included", capabilities: ["interaction.create"], requestClass: "interactive",
    }, { blocking: true, payload: { kind: "question", questions: [{ questionId: "q1", header: "Tone", question: "Formal or casual?", allowOther: true, secret: false }] } });
    worker.mockImplementationOnce(async (input) => {
      const spec = await orchestrator.runSource.loadRunSpec({ runId: input.command.runId, ownerId: OWNER, chatId: CHAT, runtimeHandle: RUNTIME, executionGeneration: "3" } as never);
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

  it("ENG344 Stop fences a late completed Bot worker reply in adapter and durable task", async () => {
    let finish: () => void = () => undefined;
    const controller = new AbortController();
    const { adapter, commands, orchestrator, registry } = setup({
      worker: (input) => new Promise((resolve) => {
        finish = () => resolve({ runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 });
      }),
    });
    const running = collect(adapter.start(turn(controller.signal)));
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const binding = registry.lookupRun({ runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_turn1" })!;
    controller.abort();
    await expect(orchestrator.eventSink.publish(binding, { seq: 0, event: { type: "assistant_delta", text: "Late" } } as never))
      .rejects.toMatchObject({ code: "stale_generation" });
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toEqual(["bot.run", "bot.cancel"]));
    // The worker ignored Stop and reported success after cancellation was acknowledged.
    finish();
    expect.soft((await running).at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
    expect.soft(await tasks()).toEqual([expect.objectContaining({ status: "cancelled", run_id: "run_turn1" })]);
  });

  it("reports Recipe Bot Stop immediately and bounds its checkpoint transport drain", async () => {
    const transportAborted = vi.fn();
    const x = setup({ cancelGraceMs: 30, worker: input => {
      input.signal?.addEventListener("abort", transportAborted, { once: true });
      return new Promise(() => undefined);
    } });
    const running = collect(x.adapter.start(turn()));
    await vi.waitFor(() => expect(x.commands.map(command => command.kind)).toEqual(["bot.run"]));
    await x.orchestrator.cancel("run_turn1");
    expect((await running).at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
    await vi.waitFor(() => expect(transportAborted).toHaveBeenCalledOnce());
  });

  it("renews the exact bound runtime and stops renewal before terminal release", async () => {
    const x = setup();
    await collect(x.adapter.start(turn()));
    expect(x.admission.startRenewal).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeHandle: RUNTIME, executionGeneration: "3", runId: "run_turn1", ownerId: OWNER }),
      expect.any(Function),
    );
    expect(x.lifecycle).toEqual(["renewal.stop", "runtime.release"]);
  });

  it("fails and releases a pending run if its lease cannot be renewed, fencing a late success", async () => {
    let finish: () => void = () => undefined;
    const x = setup({ worker: (input) => new Promise((resolve) => {
      finish = () => resolve({ runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 });
    }) });
    const running = collect(x.adapter.start(turn()));
    await vi.waitFor(() => expect(x.commands.map((command) => command.kind)).toEqual(["bot.run"]));
    x.failRenewal();
    expect((await running).at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed", run_id: "run_turn1" })]);
    expect(x.lifecycle.indexOf("renewal.stop")).toBeLessThan(x.lifecycle.indexOf("runtime.release"));
    finish();
    await Promise.resolve();
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed", run_id: "run_turn1" })]);
  }, 2_000);

  it("settles a stalled source check when runtime renewal fails before the worker starts", async () => {
    const x = setup({ assertSource: () => new Promise(() => undefined) });
    const running = collect(x.adapter.start(turn()));
    await vi.waitFor(() => expect(x.admission.startRenewal).toHaveBeenCalledTimes(1));
    x.failRenewal();
    expect((await running).at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed" })]);
    expect(x.admission.release).toHaveBeenCalledTimes(1);
  }, 2_000);

  it("bounds a hung route setup step to 60 seconds before admitting a runtime", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let routeStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { routeStarted = resolve; });
    const x = setup({ resolveRoute: () => { routeStarted(); return new Promise(() => undefined); } });
    try {
      const handle = directTurn(x.orchestrator);
      await started;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(x.admission.admit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(handle.result).resolves.toMatchObject({ status: "failed" });
      await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed" })]);
      expect(x.admission.admit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("Stop interrupts hung route setup without waiting for its watchdog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let routeStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { routeStarted = resolve; });
    const x = setup({ resolveRoute: () => { routeStarted(); return new Promise(() => undefined); } });
    try {
      const handle = directTurn(x.orchestrator);
      await started;
      await x.orchestrator.cancel("run_turn1");
      await expect(handle.result).resolves.toMatchObject({ status: "cancelled" });
      await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
      expect(x.admission.admit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("catches a rejected late task cleanup after Stop", async () => {
    let beginStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { beginStarted = resolve; });
    let finishBegin: () => void = () => undefined;
    let failLateSettle = false;
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((message: unknown) => {
      if (message === "[bots] task state was not recorded:") throw new Error("log sink unavailable");
      warnings.push(String(message));
    });
    try {
      const x = setup({ transact: (base) => async (ownerId, work) => {
        if (failLateSettle) throw new Error("state store unavailable");
        const result = await base(ownerId, work);
        if (result && typeof result === "object" && "task" in result && "continued" in result) {
          beginStarted();
          await new Promise<void>((resolve) => { finishBegin = resolve; });
        }
        return result;
      } });
      const handle = directTurn(x.orchestrator);
      await started;
      await x.orchestrator.cancel("run_turn1");
      await expect(handle.result).resolves.toMatchObject({ status: "cancelled" });
      failLateSettle = true;
      finishBegin();
      await vi.waitFor(() => expect(warnings).toContain("[bots] late setup cleanup failed:"));
      expect(x.commands).toEqual([]);
    } finally { warn.mockRestore(); }
  }, 2_000);

  it("times out hung admission and releases a runtime that appears afterward", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let admitStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { admitStarted = resolve; });
    let finishAdmit: () => void = () => undefined;
    const x = setup({ admit: () => {
      admitStarted();
      return new Promise<never>((resolve) => { finishAdmit = () => {
        x.registry.bind({ ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: "task_late", runId: "run_turn1",
          runtimeHandle: RUNTIME, executionGeneration: "3", rootFingerprint: "f".repeat(64), route: ROUTE,
          accessSourceId: "matrix_included", capabilities: [], requestClass: "interactive" } as never);
        resolve({ runtimeHandle: RUNTIME, executionGeneration: "3", rootFingerprint: "f".repeat(64) } as never);
      }; });
    } });
    try {
      const handle = directTurn(x.orchestrator);
      await started;
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(handle.result).resolves.toMatchObject({ status: "failed" });
      finishAdmit();
      await vi.waitFor(() => expect(x.admission.release).toHaveBeenCalledExactlyOnceWith(RUNTIME));
      expect(x.commands).toEqual([]);
      expect(x.admission.startRenewal).not.toHaveBeenCalled();
      await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed" })]);
    } finally { vi.useRealTimers(); }
  });

  it("Stop interrupts hung admission and releases its late runtime", async () => {
    let admitStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { admitStarted = resolve; });
    let finishAdmit: () => void = () => undefined;
    const x = setup({ admit: () => {
      admitStarted();
      return new Promise<never>((resolve) => { finishAdmit = () => resolve({ runtimeHandle: RUNTIME, executionGeneration: "3" } as never); });
    } });
    const handle = directTurn(x.orchestrator);
    await started;
    await x.orchestrator.cancel("run_turn1");
    await expect(handle.result).resolves.toMatchObject({ status: "cancelled" });
    finishAdmit();
    await vi.waitFor(() => expect(x.admission.release).toHaveBeenCalledExactlyOnceWith(RUNTIME));
    expect(x.commands).toEqual([]);
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it("bounds a hung source check after admission and releases before worker launch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let sourceStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { sourceStarted = resolve; });
    const x = setup({ assertSource: () => { sourceStarted(); return new Promise(() => undefined); } });
    try {
      const handle = directTurn(x.orchestrator);
      await started;
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(handle.result).resolves.toMatchObject({ status: "failed" });
      expect(x.commands).toEqual([]);
      expect(x.lifecycle).toEqual(["renewal.stop", "runtime.release"]);
      await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed" })]);
    } finally { vi.useRealTimers(); }
  });

  it("keeps Stop as the first cause if lease renewal fails while cancellation is in flight", async () => {
    let finish: () => void = () => undefined;
    const controller = new AbortController();
    const x = setup({ worker: (input) => new Promise((resolve) => {
      finish = () => resolve({ runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 });
    }) });
    const running = collect(x.adapter.start(turn(controller.signal)));
    await vi.waitFor(() => expect(x.commands.map((command) => command.kind)).toEqual(["bot.run"]));
    controller.abort();
    x.failRenewal();
    finish();
    expect((await running).at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "cancelled", run_id: "run_turn1" })]);
    expect(x.lifecycle.indexOf("renewal.stop")).toBeLessThan(x.lifecycle.indexOf("runtime.release"));
    expect(x.lifecycle.indexOf("renewal.stop")).toBeLessThan(x.lifecycle.indexOf("worker.cancel"));
  });

  it("releases a runtime once when Stop's cancel cannot be delivered and its worker later finishes", async () => {
    let finish: () => void = () => undefined;
    const controller = new AbortController();
    const x = setup({ cancelDelivered: false, worker: (input) => new Promise((resolve) => {
      finish = () => resolve({ runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 });
    }) });
    const running = collect(x.adapter.start(turn(controller.signal)));
    await vi.waitFor(() => expect(x.commands.map((command) => command.kind)).toEqual(["bot.run"]));
    controller.abort();
    await vi.waitFor(() => expect(x.admission.release).toHaveBeenCalledWith(RUNTIME));
    finish();
    expect((await running).at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
    expect(x.admission.release).toHaveBeenCalledTimes(1);
  });

  it("keeps an active Bot turn alive beyond the former ten-minute task cutoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
    let started: () => void = () => undefined;
    const workerStarted = new Promise<void>((resolve) => { started = resolve; });
    let finish: () => void = () => undefined;
    const x = setup({ worker: (input) => {
      started();
      return new Promise((resolve) => {
        finish = () => resolve({ runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 });
      });
    } });
    try {
      const running = collect(x.adapter.start(turn()));
      await workerStarted;
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      expect(x.commands.map((command) => command.kind)).toEqual(["bot.run"]);
      finish();
      expect((await running).at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
      await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "completed" })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Stop as the first cause after a late blocked reply", async () => {
    let finish: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const controller = new AbortController();
    const { adapter, commands } = setup({
      worker: (input) => {
        markStarted();
        return new Promise((resolve) => {
          finish = () => resolve({ runId: input.command.runId, status: "blocked", blockedReason: "tool_unavailable", toolActions: 0, sessionRevision: 1 });
        });
      },
    });
    const running = collect(adapter.start(turn(controller.signal)));
    await started;
    controller.abort();
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toContain("bot.cancel"));
    finish();
    expect((await running).at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "cancelled", run_id: "run_turn1" })]);
  });

  it("keeps lease loss as the first stop cause when Stop follows it", async () => {
    let finish: () => void = () => undefined;
    const controller = new AbortController();
    const { adapter, commands, failRenewal } = setup({
      worker: (input) => new Promise((resolve) => {
        finish = () => resolve({ runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 });
      }),
    });
    const running = collect(adapter.start(turn(controller.signal)));
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toEqual(["bot.run"]));
    failRenewal();
    controller.abort();
    finish();
    expect((await running).at(-1)).toMatchObject({ type: "run.completed", outcome: "failed", error: { code: "run_failed" } });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "failed", run_id: "run_turn1" })]);
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
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toContain("bot.run"));
    const stopping = events.return!(undefined);
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toEqual(["bot.run", "bot.cancel"]));
    finish(undefined);
    await stopping;
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it("stops a worker that took the cancel but did not end its run", async () => {
    const aborted = new AbortController();
    const { adapter, commands, admission } = setup({ cancelGraceMs: 30, worker: () => new Promise(() => undefined) });
    const running = collect(adapter.start(turn(aborted.signal)));
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    aborted.abort();
    await vi.waitFor(() => expect(commands.map((command) => command.kind)).toEqual(["bot.run", "bot.cancel"]));
    await vi.waitFor(() => expect(admission.release).toHaveBeenCalledWith(RUNTIME));
    expect((await running).at(-1)).toEqual({ type: "run.completed", outcome: "aborted" });
    await expect(tasks()).resolves.toEqual([expect.objectContaining({ status: "cancelled" })]);
  }, 2_000);

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

  it.each([{ acknowledged: false }, {}])("rejects an unacknowledged steer even when its transport succeeds: %j", async steerReply => {
    const gate = Promise.withResolvers<unknown>();
    const { adapter, commands } = setup({ steerReply, worker: () => gate.promise });
    const running = collect(adapter.start(turn()));
    try {
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      await expect(adapter.steer!({ ...turn(), clientRequestId: "req_undelivered" })).rejects.toThrow();
    } finally {
      gate.resolve({ runId: "run_turn1", status: "completed", toolActions: 0 });
      await running;
    }
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

it("runs new custom coordinators through the Bot adapter with exact subscription and revision on fresh/resumed turns", async () => {
 const selection={instanceId:"matrix_chatgpt_plan",model:"gpt-custom",options:[{id:"accountId",value:"own-account"},{id:"grantRevision",value:"3"}]};
 const agent={...AGENT,selection,instructions:"Use only confirmed data",recipeRef:{recipeId:"custom-coordinator",version:"1"}};
 const resolveProcedure=fixtureMock(async()=>({...agent.recipeRef,name:agent.name,description:"",instructions:agent.instructions,
  capabilities:["artifact.read" as const,"memory.search" as const],integrations:[],output:"A truthful answer"}));
 const subscription={peerId:"d16576f5-6a86-4768-8f97-06a718efda36",accountId:"own-account",computerId:"own-computer",grantRevision:3};
 const route={...ROUTE,api:"openai-responses" as const,modelId:selection.model};
 const resolveRoute=fixtureMock(async(selected?:CanonicalChatModelSelection)=>{expect(selected).toEqual(selection);return {route,accessSourceId:"matrix_chatgpt_plan" as const,subscription};});
 const x=setup({agent,resolveProcedure,resolveRoute,worker:async(input)=>{
  const spec=await x.orchestrator.runSource.loadRunSpec({runId:input.command.runId, ownerId:OWNER, chatId:CHAT, runtimeHandle:RUNTIME, executionGeneration:"3"} as never);
  expect(spec.systemPrompt).toContain(agent.instructions); expect(spec.route).toEqual(route);
  expect(x.registry.lookupRun({...input,runId:input.command.runId})).toMatchObject({ownerId:OWNER,botId:BOT,managedDefinitionRevision:1,subscription});
  return {runId:input.command.runId,status:"completed",toolActions:0,sessionRevision:1};
 }});
 for(const runId of ["run_custom_fresh","run_custom_resume"]){
  await collect(x.adapter.start(turn(undefined,runId)));
  expect(await tasks()).toContainEqual(expect.objectContaining({status:"completed",run_id:runId}));
 }
 expect(resolveProcedure).toHaveBeenCalledTimes(2);expect(resolveRoute).toHaveBeenCalledTimes(2);
 const bad=x.orchestrator.start({ownerId:OWNER,chatId:CHAT,runId:"run_custom_changed",text:"No source changes",selection:{...selection,model:"foreign-model"},signal:new AbortController().signal});
 expect(await bad.result).toEqual({status:"failed"}); expect(resolveRoute).toHaveBeenCalledTimes(2);
});

it("forwards image/file-only recipe Bot turns through the real broker and image-hydrating Pi worker", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai");
  const { createBotWorker } = await import("../../../packages/bot-runtime/src/worker.js");
  const { BotBrokerError } = await import("../../../packages/bot-runtime/src/broker-client.js");
  const { createBotBrokerActions } = await import("../../../packages/gateway/src/bots/broker-actions.js");
  const { createBotCheckpointsRepository } = await import("../../../packages/gateway/src/bots/repositories/checkpoints.js");
  const { createBotSessionsRepository } = await import("../../../packages/gateway/src/bots/repositories/sessions.js");
  const home = await mkdtemp(join(tmpdir(), "recipe-inputs-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
  const route = { ...ROUTE, input: ["text", "image"] as ("text" | "image")[] };
  const faux = fauxProvider({ models: [{ id: route.modelId, input: route.input, contextWindow: route.contextWindow, maxTokens: route.maxOutputTokens }] });
  let observed = 0;
  for (let index = 0; index < 2; index++) faux.appendResponses([
    context => {
      const user = [...context.messages].reverse().find(message => message.role === "user")!;
      const content = user.content as Array<{ type: string; text?: string }>;
      expect(content.find(item => item.type === "image")).toMatchObject({ data: png.toString("base64"), mimeType: "image/png" }); observed++;
      const alias = content.find(item => item.type === "text")!.text!.match(/read_artifact path=(submitted-inputs\/[a-f0-9-]+)/)![1]!;
      return fauxAssistantMessage(fauxToolCall("read_artifact", { path: alias }, { id: `recipe_read_${index}` }), { stopReason: "toolUse" });
    },
    context => { expect(JSON.stringify(context.messages.at(-1))).toContain("RECIPE_FILE_MARKER"); return fauxAssistantMessage(fauxText("RECIPE_FILE_MARKER")); },
  ]);
  let actions: ReturnType<typeof createBotBrokerActions>;
  const inputHistory = vi.fn(async () => ({ references: [], assertCurrent: async () => undefined }));
  const x = setup({ homePath: home, inputHistory, resolveRoute: async () => ({ route, accessSourceId: "matrix_included" }), worker: async input => {
    const call = async (body: Record<string, unknown>) => {
      const reply = await actions.handleFrame({ version: 1, requestId: crypto.randomUUID(), runtimeHandle: input.runtimeHandle, executionGeneration: input.executionGeneration, runId: input.command.runId, ...body });
      if (!reply?.ok) throw new BotBrokerError((reply?.code ?? "unavailable") as never); return reply.result;
    };
    const worker = createBotWorker({ bridgeOrigin: "http://127.0.0.1:41000", route: { provider: faux.provider, model: faux.getModel() }, brokerFor: () => ({
      loadRun: () => call({ action: "bot.run.load" }) as never, readImageChunk: image => call({ action: "bot.input.image", image }) as never,
      loadSession: () => call({ action: "bot.session.load" }) as never, saveSession: session => call({ action: "bot.session.save", session }) as never,
      event: async event => { await call({ action: "bot.event", event }); }, tool: tool => call({ action: "bot.tool", tool }) as never,
    }) });
    return worker.handle({ version: 1, kind: "bot.run", runId: input.command.runId });
  } });
  actions = createBotBrokerActions({ db, registry: x.registry, sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db),
    runs: x.orchestrator.runSource, events: x.orchestrator.eventSink,
    tools: { effectClass: () => "read", dispatch: async (binding, request) => {
      if (request.capability !== "artifact.read") throw new Error("Only submitted reads");
      const text = await x.orchestrator.readSubmittedArtifact(binding, request.args); expect(text).toBe("RECIPE_FILE_MARKER");
      return { result: { ok: true, content: [{ type: "text", text: text! }] } };
    } }, inference: { homePath: home, lifetime: new AbortController().signal } });
  try {
    await mkdir(join(home, "temporary/desktop-chat"), { recursive: true }); await writeFile(join(home, "temporary/desktop-chat/photo.png"), png); await writeFile(join(home, "temporary/desktop-chat/marker.txt"), "RECIPE_FILE_MARKER");
    const parts = [{ type: "attachment_reference" as const, attachmentId: "att_recipe_photo", kind: "image" as const, mimeType: "image/png", label: "photo.png", ownerReference: "temporary/desktop-chat/photo.png" },
      { type: "attachment_reference" as const, attachmentId: "att_recipe_file", kind: "file" as const, mimeType: "text/plain", label: "marker.txt", ownerReference: "temporary/desktop-chat/marker.txt" }];
    for (let index = 0; index < 2; index++) {
      const events = await collect(x.adapter.start({ ...turn(undefined, `run_recipe_input_${index}`, ""), prompt: "Inspect attached files", parts }));
      expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
      expect(events).toContainEqual({ type: "assistant.delta", delta: "RECIPE_FILE_MARKER" });
    }
    expect(observed).toBe(2); expect(faux.state.callCount).toBe(4); expect(x.registry.size).toBe(0);
    expect(inputHistory).toHaveBeenCalledTimes(2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

describe("group Pi run isolation", () => {
  it.each((["resolve", "authorize", "route"] as const).flatMap(stage => (["signal", "cancel", "deadline"] as const).map(stop => ({ stage, stop }))))("settles stalled group $stage on $stop before late authority", async ({ stage, stop }) => {
    await insertChat(db, "chat_company1");
    await db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: BOT, chat_id: "chat_company1", kind: "group", created_at: "2026-09-27T12:00:00.000Z", removed_at: null }).execute();
    const group = { scopeId: "scope-company", actorId: "user_member", executionRoot: { kind: "project" as const, projectId: "project_company" }, executionRootFingerprint: "f".repeat(64), sessionGeneration: "1" };
    const authority = { scopeId: "scope-company", actorId: "user_member", ownerId: OWNER, resourceId: "chat_company1", resourceKind: "chat" as const, organizationId: "org_company", membershipScopeId: "scope-company", authEpoch: 4, authorityGeneration: 1, authorityRuntimeId: "owner-runtime", capability: "request_ai" as const, role: "editor" as const };
    const input = new AbortController(), deadline = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const resolveGroupRun = vi.fn(async () => { if (stage === "resolve") await gate; return group; });
    const authorizeGroup = vi.fn(async () => { if (stage === "authorize") await gate; return authority; });
    const resolveGroupRoute = vi.fn(async () => { if (stage === "route") await gate; return { route: ROUTE, accessSourceId: "matrix_included" as const }; });
    const service = setup({ resolveGroupRun, authorizeGroup, resolveGroupRoute });
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 10_000 ? deadline.signal : originalTimeout(ms));
    const runId = `run_prelaunch_${stage}_${stop}`;
    const handle = service.orchestrator.start({ ownerId: OWNER, chatId: "chat_company1", runId, text: "Synthetic group turn", signal: input.signal });
    const result = handle.result.then(value => ({ kind: "settled" as const, value }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observed: Awaited<typeof result> | { kind: "still_waiting" };
    let slotReleased = false;
    try {
      await vi.waitFor(() => expect(stage === "resolve" ? resolveGroupRun : stage === "authorize" ? authorizeGroup : resolveGroupRoute).toHaveBeenCalledOnce());
      if (stop === "signal") input.abort();
      else if (stop === "cancel") await service.orchestrator.cancel(runId);
      else deadline.abort(new DOMException("Synthetic authorization deadline", "TimeoutError"));
      observed = await Promise.race([result, new Promise<{ kind: "still_waiting" }>(resolve => { timer = setTimeout(() => resolve({ kind: "still_waiting" }), 750); })]);
      if (observed.kind === "settled") {
        const cancelled = new AbortController(); cancelled.abort();
        const next = service.orchestrator.start({ ownerId: OWNER, chatId: "chat_company1", runId, text: "Already cancelled", signal: cancelled.signal });
        slotReleased = true; await next.result;
      }
    } finally {
      if (timer) clearTimeout(timer);
      release(); await result; timeout.mockRestore();
    }
    expect(observed!, stop).toMatchObject({ kind: "settled", value: stop === "deadline" ? { status: "blocked", blockedReason: "deadline_reached" } : { status: "cancelled" } });
    expect(slotReleased, stop).toBe(true);
    expect(service.admission.admit, stop).not.toHaveBeenCalled();
    expect(service.commands, stop).not.toContainEqual(expect.objectContaining({ kind: "bot.run" }));
  });
  it.each(["cancel", "deadline"] as const)("bounds group steering authorization on %s without a late command", async stop => {
    await insertChat(db, "chat_company1");
    await db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: BOT, chat_id: "chat_company1", kind: "group", created_at: "2026-09-27T12:00:00.000Z", removed_at: null }).execute();
    let releaseAuthority!: () => void, finishWorker!: () => void;
    const gate = new Promise<void>(resolve => { releaseAuthority = resolve; });
    let calls = 0;
    const service = setup({
      resolveGroupRun: async () => ({ scopeId: "scope-company", actorId: "user_member", executionRoot: { kind: "project", projectId: "project_company" }, executionRootFingerprint: "f".repeat(64), sessionGeneration: "1" }),
      authorizeGroup: async () => {
        if (++calls === 2) await gate;
        return { scopeId: "scope-company", actorId: "user_member", ownerId: OWNER, resourceId: "chat_company1", resourceKind: "chat", organizationId: "org_company", membershipScopeId: "scope-company", authEpoch: 4, authorityGeneration: 1, authorityRuntimeId: "owner-runtime", capability: "request_ai", role: "editor" };
      },
      worker: input => new Promise(resolve => { finishWorker = () => resolve({ runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 }); }),
    });
    const deadline = new AbortController(), originalTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 10_000 ? deadline.signal : originalTimeout(ms));
    const runId = `run_steer_${stop}`;
    const running = service.orchestrator.start({ ownerId: OWNER, chatId: "chat_company1", runId, text: "Synthetic group turn", signal: new AbortController().signal });
    let pending: Promise<boolean> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let observed: boolean | "still_waiting";
    try {
      await vi.waitFor(() => expect(service.commands).toContainEqual(expect.objectContaining({ kind: "bot.run" })));
      pending = service.orchestrator.steer(runId, "Synthetic steering");
      await vi.waitFor(() => expect(calls).toBe(2));
      if (stop === "cancel") await service.orchestrator.cancel(runId);
      else deadline.abort(new DOMException("Synthetic authorization deadline", "TimeoutError"));
      observed = await Promise.race([pending, new Promise<"still_waiting">(resolve => { timer = setTimeout(() => resolve("still_waiting"), 750); })]);
    } finally {
      if (timer) clearTimeout(timer);
      releaseAuthority(); if (pending) await pending;
      finishWorker?.(); await running.result; timeout.mockRestore();
    }
    expect(observed!).toBe(false);
    expect(service.commands).not.toContainEqual(expect.objectContaining({ kind: "bot.steer" }));
  });
  it.each(["text", "image", "file"] as const)("never calls owner history or upload resolution for a group %s turn", async kind => {
    const fs = await import("node:fs/promises");
    const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
    const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "group-input-boundary-")));
    const inputHistory = vi.fn(async () => ({ references: [], assertCurrent: async () => undefined }));
    const resolveRoute = vi.fn(); const admitted = vi.fn(async () => ["PRIVATE OWNER FACT"]);
    const executorReady = vi.fn(async () => true);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
    const file = kind === "image" ? "photo.png" : "marker.txt";
    try {
      await fs.mkdir(join(home, "temporary/desktop-chat"), { recursive: true });
      await fs.writeFile(join(home, "temporary/desktop-chat", file), kind === "image" ? png : "PRIVATE_OWNER_UPLOAD");
      await insertChat(db, "chat_company1");
      await db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: BOT, chat_id: "chat_company1", kind: "group", created_at: "2026-09-27T12:00:00.000Z", removed_at: null }).execute();
      const service = setup({ homePath: home, inputHistory, admitted, executorReady, resolveRoute,
        resolveGroupRoute: async () => ({ route: { ...ROUTE, input: ["text", "image"] }, accessSourceId: "matrix_included" }),
        authorizeGroup: async () => ({ scopeId: "scope-company", actorId: "user_member", ownerId: OWNER, resourceId: "chat_company1", resourceKind: "chat", organizationId: "org_company", membershipScopeId: "scope-company", authEpoch: 4, authorityGeneration: 1, authorityRuntimeId: "owner-runtime", capability: "request_ai", role: "editor" }),
        resolveGroupRun: async () => ({ scopeId: "scope-company", actorId: "user_member", executionRoot: { kind: "project", projectId: "project_company" }, executionRootFingerprint: "f".repeat(64), sessionGeneration: "1" }),
      });
      const beforeResolve = vi.mocked(fs.realpath).mock.calls.length;
      const beforeOpen = vi.mocked(fs.open).mock.calls.length;
      const parts: import("@matrix-os/contracts").CanonicalChatMessagePart[] = kind === "text" ? [{ type: "text", text: "Group request" }] : [{
        type: "attachment_reference", attachmentId: `att_group_${kind}`, kind, mimeType: kind === "image" ? "image/png" : "text/plain",
        label: file, ownerReference: `temporary/desktop-chat/${file}`,
      }];
      const result = await service.orchestrator.start({ ownerId: OWNER, chatId: "chat_company1", runId: `run_group_${kind}`, text: "Group request", parts, signal: new AbortController().signal }).result;
      expect.soft(inputHistory).not.toHaveBeenCalled();
      expect.soft(vi.mocked(fs.realpath).mock.calls.slice(beforeResolve).filter(args => args[0] === home)).toHaveLength(0);
      expect.soft(vi.mocked(fs.open).mock.calls.slice(beforeOpen).filter(args => String(args[0]).startsWith(`${home}/temporary/desktop-chat/`))).toHaveLength(0);
      expect.soft(resolveRoute).not.toHaveBeenCalled(); expect.soft(admitted).not.toHaveBeenCalled(); expect.soft(executorReady).not.toHaveBeenCalled();
      if (kind === "text") expect.soft(result.status).toBe("completed");
      else {
        expect.soft(result).toMatchObject({ status: "blocked", blockedReason: "policy_denied" });
        expect.soft(service.admission.admit).not.toHaveBeenCalled();
      }
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
  it("uses an explicit group binding and omits all private context and capabilities", async () => {
    await insertChat(db, "chat_company1");
    await db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: BOT, chat_id: "chat_company1", kind: "group", created_at: "2026-09-27T12:00:00.000Z", removed_at: null }).execute();
    const admitted = vi.fn(async () => ["PRIVATE OWNER FACT"]);
    const executorReady = vi.fn(async () => true);
    let orchestrator: ReturnType<typeof createBotTaskOrchestrator>;
    const service = setup({ admitted, executorReady, routineTools: true,
      authorizeGroup: async () => ({ scopeId: "scope-company", actorId: "user_member", ownerId: OWNER, resourceId: "chat_company1", resourceKind: "chat", organizationId: "org_company", membershipScopeId: "scope-company", authEpoch: 4, authorityGeneration: 1, authorityRuntimeId: "owner-runtime", capability: "request_ai", role: "editor" }),
      resolveGroupRun: async () => ({ scopeId: "scope-company", actorId: "user_member", executionRoot: { kind: "project", projectId: "project_company" }, executionRootFingerprint: "f".repeat(64), sessionGeneration: "1" }),
      worker: async (input) => {
        const binding = service.registry.lookupRun({ runtimeHandle: input.runtimeHandle, executionGeneration: input.executionGeneration, runId: input.command.runId });
        expect(binding).toBeDefined();
        const spec = await orchestrator.runSource.loadRunSpec(binding!);
        expect(spec.systemPrompt).not.toContain("PRIVATE OWNER FACT");
        expect(spec.systemPrompt).toContain("shared company thread");
        expect(spec.capabilities).toEqual([]);
        return { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 };
      },
    });
    orchestrator = service.orchestrator;
    const events = await collect(service.adapter.start({ ...turn(), chatId: "chat_company1" }));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
    expect(admitted).not.toHaveBeenCalled();
    expect(executorReady).not.toHaveBeenCalled();
    expect(service.admission.admit).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat_company1", expectedRootFingerprint: "f".repeat(64), group: expect.objectContaining({ actorId: "user_member" }) }));
  });
  it("refuses a group Chat when no explicit resolver is wired, without private fallback", async () => {
    await insertChat(db, "chat_company1");
    await db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: BOT, chat_id: "chat_company1", kind: "group", created_at: "2026-09-27T12:00:00.000Z", removed_at: null }).execute();
    const service = setup();
    const events = await collect(service.adapter.start({ ...turn(), chatId: "chat_company1" }));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    expect(service.admission.admit).not.toHaveBeenCalled();
  });
});

it("runs a scheduled turn on its claimed task with background inference admission",async()=>{
  const existing=await createBotTasksRepository(db).create({ownerId:OWNER,botId:BOT,chatId:CHAT,now:AGENT.createdAt});
  const selection={instanceId:"matrix_chatgpt_plan" as const,model:"fixture-scheduled",options:[{id:"accountId",value:"fixture-account"},{id:"grantRevision",value:"3"}]};
  const subscription={accountId:"fixture-account",computerId:"fixture-computer",grantRevision:3,peerId:"f2b7ba8f-009b-4603-8967-c3e6bdfb276e"};
  const resolveRoute=vi.fn(async()=>({accessSourceId:"matrix_chatgpt_plan" as const,subscription,route:{...ROUTE,api:"openai-responses" as const,modelId:selection.model}}));
  const {orchestrator,admission}=setup({agent:{...AGENT,selection},resolveRoute});
  const handle=orchestrator.start({ownerId:OWNER,chatId:CHAT,runId:"run_scheduled_fixture",text:"approved fixture",selection,signal:new AbortController().signal,backgroundTaskId:existing.taskId});
  expect(await handle.result).toEqual({status:"completed"});
  expect(await tasks()).toEqual([expect.objectContaining({run_id:"run_scheduled_fixture",status:"completed"})]);
  expect(resolveRoute).toHaveBeenCalledWith(selection,"background");
  expect(admission.admit).toHaveBeenCalledWith(expect.objectContaining({taskId:existing.taskId,requestClass:"background"}));
});

it.each(["completed","uncertain"] as const)("replaces a routine's canonical input and projects durable %s outcome",async(outcome)=>{
 const task=await createBotTasksRepository(db).create({ownerId:OWNER,botId:BOT,chatId:CHAT,now:AGENT.createdAt});
 const selection={instanceId:"matrix_chatgpt_plan" as const,model:"fixture-scheduled",options:[{id:"accountId",value:"fixture-account"},{id:"grantRevision",value:"3"}]};
 const subscription={accountId:"fixture-account",computerId:"fixture-computer",grantRevision:3,peerId:"f2b7ba8f-009b-4603-8967-c3e6bdfb276e"};
 const completeRun=vi.fn(async()=>outcome==="uncertain"?{status:"uncertain" as const}:undefined),prepareRun=vi.fn(async()=>({backgroundTaskId:task.taskId,text:"exact approved fixture",selection}));
 const context=setup({agent:{...AGENT,selection},resolveRoute:async()=>({accessSourceId:"matrix_chatgpt_plan",subscription,route:{...ROUTE,api:"openai-responses",modelId:selection.model}}),worker:async input=>{
  const spec=await context.orchestrator.runSource.loadRunSpec(context.registry.lookupRun({...input,runId:input.command.runId})!);expect(spec.turn).toMatchObject({text:"exact approved fixture"});return {runId:input.command.runId,status:"completed",toolActions:0,sessionRevision:1};
 }});
 const adapter=createMatrixBotChatProviderAdapter({orchestrator:context.orchestrator,stopRuntime:async()=>{},routines:{prepareRun,completeRun}});
 const projected=(await collect(adapter.start(turn(undefined,"run_approved_fixture","unapproved forged text")))).at(-1);
 if(outcome==="completed")expect(projected).toEqual({type:"run.completed",outcome:"completed"});
 else expect(projected).toMatchObject({type:"run.completed",outcome:"failed",error:{retryable:false,recoveryActions:[]}});
 expect(completeRun).toHaveBeenCalledWith(expect.objectContaining({runId:"run_approved_fixture"}),{status:"completed"});


});

it("reports an owned scheduled capacity refusal before starting a worker and reuses only that blocked task",async()=>{
 const existing=await createBotTasksRepository(db).create({ownerId:OWNER,botId:BOT,chatId:CHAT,now:AGENT.createdAt});
 const selection={instanceId:"matrix_chatgpt_plan" as const,model:"fixture-scheduled",options:[{id:"accountId",value:"fixture-account"},{id:"grantRevision",value:"3"}]};
 const subscription={accountId:"fixture-account",computerId:"fixture-computer",grantRevision:3,peerId:"f2b7ba8f-009b-4603-8967-c3e6bdfb276e"};
 const x=setup({agent:{...AGENT,selection},resolveRoute:async()=>({accessSourceId:"matrix_chatgpt_plan",subscription,route:{...ROUTE,api:"openai-responses",modelId:selection.model}}),admit:async()=>{throw new BotAdmissionError("capacity_exceeded");}});
 const completeRun=vi.fn(async()=>{}),adapter=createMatrixBotChatProviderAdapter({orchestrator:x.orchestrator,stopRuntime:async()=>{},routines:{prepareRun:async()=>({backgroundTaskId:existing.taskId,selection,text:"approved"}),completeRun}});
 await collect(adapter.start(turn(undefined,"run_capacity_first","approved")));
 expect(completeRun).toHaveBeenCalledWith(expect.anything(),{status:"blocked",blockedReason:"capacity_unavailable",retryableBeforeDispatch:true});
 expect(x.commands).toEqual([]);
 const y=setup({agent:{...AGENT,selection},resolveRoute:async()=>({accessSourceId:"matrix_chatgpt_plan",subscription,route:{...ROUTE,api:"openai-responses",modelId:selection.model}})});
 const handle=y.orchestrator.start({ownerId:OWNER,chatId:CHAT,runId:"run_capacity_second",text:"approved",selection,backgroundTaskId:existing.taskId,signal:new AbortController().signal});
 expect(await handle.result).toEqual({status:"completed"});
 expect(await tasks()).toEqual([expect.objectContaining({run_id:"run_capacity_second",status:"completed"})]);
 expect((await createBotTasksRepository(db).get({ownerId:OWNER,taskId:existing.taskId}))?.status).toBe("completed");
});


it.each([false, true])("exposes routine tools only on personal interactive runs; background=%s", async background => {
  const selection = { instanceId: "matrix_chatgpt_plan", model: "fixture-scheduled", options: [{ id: "accountId", value: "fixture-account" }, { id: "grantRevision", value: "3" }] };
  const subscription = { accountId: "fixture-account", computerId: "fixture-computer", grantRevision: 3, peerId: "f2b7ba8f-009b-4603-8967-c3e6bdfb276e" };
  const task = background ? await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: AGENT.createdAt }) : undefined;
  const context = setup({ routineTools: true, agent: { ...AGENT, selection },
    resolveRoute: async () => ({ accessSourceId: "matrix_chatgpt_plan", subscription, route: { ...ROUTE, api: "openai-responses", modelId: selection.model } }),
    worker: async input => {
      const binding = context.registry.lookupRun({ ...input, runId: input.command.runId })!;
      const spec = await context.orchestrator.runSource.loadRunSpec(binding);
      expect(spec.capabilities.includes("routine.propose")).toBe(!background);
      expect(spec.capabilities.includes("routine.control")).toBe(!background);
      return { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 };
    },
  });
  const handle = context.orchestrator.start({ ownerId: OWNER, chatId: CHAT, runId: `run_combo_${background}`, text: "Synthetic exact fixture",
    selection, signal: new AbortController().signal, ...(task ? { backgroundTaskId: task.taskId } : {}) });
  expect(await handle.result).toEqual({ status: "completed" });
});

it("refuses a group background task before authority routing, task mutation or worker admission", async () => {
  const chatId = "chat_group_background";
  await insertChat(db, chatId);
  await db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: BOT, chat_id: chatId, kind: "group", created_at: AGENT.createdAt, removed_at: null }).execute();
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId, now: AGENT.createdAt });
  const before = await db.selectFrom("bot_tasks").selectAll().orderBy("task_id").execute();
  const resolveGroupRun = vi.fn(async () => ({ scopeId: "scope-company", actorId: "user_member", executionRoot: { kind: "project", projectId: "project_company" }, executionRootFingerprint: "f".repeat(64), sessionGeneration: "1" }));
  const context = setup({ routineTools: true, resolveGroupRun,
    authorizeGroup: async () => ({ scopeId: "scope-company", actorId: "user_member", ownerId: OWNER, resourceId: chatId, resourceKind: "chat", organizationId: "org_company", membershipScopeId: "scope-company", authEpoch: 4, authorityGeneration: 1, authorityRuntimeId: "owner-runtime", capability: "request_ai", role: "editor" }),
  });
  const handle = context.orchestrator.start({ ownerId: OWNER, chatId, runId: "run_group_background", text: "Synthetic denied background request",
    signal: new AbortController().signal, backgroundTaskId: task.taskId });
  expect(await handle.result).toEqual({ status: "failed" });
  expect(resolveGroupRun).not.toHaveBeenCalled();
  expect(context.admission.admit).not.toHaveBeenCalled();
  expect(context.commands).toEqual([]);
  expect(await db.selectFrom("bot_tasks").selectAll().orderBy("task_id").execute()).toEqual(before);
});
