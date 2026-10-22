import type { BotInputHistoryReader } from "../bots/historical-input.js";
import { BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES } from "@matrix-os/contracts";
import { prepareBotInputs, type PreparedBotInputs } from "../bots/admitted-input.js";
import { BotRunSpecSchema, BotRunOutcomeSchema, type BotEvent, type BotRunSpec } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { BotBrokerActionError, type BotEventSink, type BotRunSource } from "../bots/broker-actions.js";
import { mapBotEvent, MAX_BOT_ACTIVITY_EVENTS } from "../bots/chat-adapter.js";
import { BotRouteError } from "../bots/route-resolver.js";
import { readTrustedBotRunLimits } from "../bots/trusted-inference-limits.js";
import { BOT_RUNTIME_REGISTRY_CAPACITY, isManagedPiBinding, type ManagedPiRuntimeBinding, type PiRuntimeBinding } from "../bots/runtime-registry.js";
import type { ScopeRuntimeHost } from "../scope-runtime-host/index.js";
import type { AiProviderSnapshotReader } from "../ai-providers/service.js";
import { createCanonicalCliEventQueue } from "./cli-process.js";
import { CanonicalProviderRunEventSchema, parseCanonicalProviderRunInput, type CanonicalChatProviderAdapter, type CanonicalProviderRunEvent, type CanonicalProviderRunInput } from "./provider-adapter.js";
import type { ManagedPiAdmission } from "./managed-pi-admission.js";
import { resolveManagedPiSelection } from "./managed-pi-route.js";
import { createManagedPiSystemPrompt, ManagedPiPersonalityError, type ManagedPiPersonalityConfig } from "./managed-pi-system-prompt.js";
import { fundedChatError, type FundedChatFailureReason } from "./funded-chat-error.js";
import { assertTextOnlySteering } from "./steer-delivery-error.js";

const StateSchema = z.object({ runtimeHandle: z.string().regex(/^runtime_[a-f0-9]{32}$/), executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/) }).strict();
// Match the supervisor's typed runtime.bot errors; never log its reply or error text.
const TransportErrorSchema = z.enum(["invalid_request", "runtime_not_found", "runtime_unavailable", "generation_mismatch", "busy"]);
type WorkerFailure =
  | { stage: "worker_transport"; error: z.infer<typeof TransportErrorSchema> | "unknown" }
  | { stage: "worker_invalid_reply" | "worker_run_mismatch" }
  | { stage: "worker_outcome"; status: z.infer<typeof BotRunOutcomeSchema>["status"];
      failureCode: z.infer<typeof BotRunOutcomeSchema>["failureCode"] | null;
      blockedReason: z.infer<typeof BotRunOutcomeSchema>["blockedReason"] | null; toolActions: number };
class ManagedPiWorkerFailure extends Error {
  constructor(readonly diagnostic: WorkerFailure) { super("Pi run failed"); }
}
function diagnosticErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return ["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError", "ZodError", "BotRouteError", "BotBrokerActionError"].includes(name) ? name : "UnknownError";
}
type State = z.infer<typeof StateSchema>;
type Event = { kind: "canonical"; event: CanonicalProviderRunEvent } | { kind: "worker"; event: BotEvent["event"] } | { kind: "state"; state: State };
interface Active {
  ownerId: string; chatId: string; spec?: BotRunSpec; binding?: ManagedPiRuntimeBinding;
  queue: ReturnType<typeof createCanonicalCliEventQueue<Event>>;
  stopping: boolean; finished: boolean; grace?: ReturnType<typeof setTimeout>;
  fundedFailure?: FundedChatFailureReason;
  isolated: boolean;
  inputs?: PreparedBotInputs;
  signal?: AbortSignal;
}

/** Two policies use one pinned worker/broker. Ordinary Chat has no recipe or bot grants. */
export function createManagedPiRuntime(deps: {
  toolOutputKey?: Buffer;
  homePath?: string; expectedOwnerId?: string | null; inputHistory?: BotInputHistoryReader;
  chatgptPlan?: import("../bots/chatgpt-plan.js").ChatGptPlanAuthority;
  matrixAnthropic?: import("../bots/matrix-anthropic-api.js").MatrixAnthropicAuthority;
  isolatedChat?: import("./isolated-chat-envelope.js").IsolatedChatAuthority;
  personality?: ManagedPiPersonalityConfig;
  ownerTools?: import("./managed-pi-owner-tools.js").ManagedPiOwnerTools;
  assertSource?(binding: PiRuntimeBinding, signal: AbortSignal): Promise<void>;
  admission: ManagedPiAdmission; host: ScopeRuntimeHost; providers: AiProviderSnapshotReader; lifetime: AbortSignal;
  forgetRun(runId: string): void;
  cancelInference(binding: ManagedPiRuntimeBinding): void;
}) {
  const systemPrompt = createManagedPiSystemPrompt(deps.personality);
  const limits = readTrustedBotRunLimits();
  const active = new Map<string, Active>(); // capacity/terminal eviction below; runtime deadline bounds lifetime.
  async function stop(runId: string): Promise<void> {
    const run = active.get(runId); if (!run || run.finished) return;
    run.stopping = true;
    run.inputs?.dispose();
    const binding = run.binding;
    if (binding) deps.cancelInference(binding);
    // Local approvals are revoked synchronously; Platform revocation is bounded and must not delay Stop.
    void deps.ownerTools?.closeRun(runId).catch((error: unknown) => console.warn("[managed-pi] tool close failed", error instanceof Error ? error.name : "UnknownError"));
    if (!binding) return;
    let delivered = false;
    try { delivered = (await deps.host.client.runBot({ ...binding, command: { version: 1, kind: "bot.cancel", runId } })).ok; }
    catch (error: unknown) { console.warn("[managed-pi] cancel delivery failed", error instanceof Error ? error.name : "UnknownError"); }
    if (!delivered) { await deps.admission.release(binding.runtimeHandle); return; }
    run.grace ??= setTimeout(() => {
      if (!run.finished) void deps.admission.release(binding.runtimeHandle).catch((error: unknown) => console.warn("[managed-pi] runtime release failed", error instanceof Error ? error.name : "UnknownError"));
    }, 10_000);
    run.grace.unref();
  }
  async function execute(input: CanonicalProviderRunInput<State>, run: Active): Promise<CanonicalProviderRunEvent> {
    const signal = AbortSignal.any([input.signal, deps.lifetime, AbortSignal.timeout(10 * 60_000)]);
    run.signal = signal;
    const onAbort = () => { void stop(input.runId).catch((error: unknown) => console.warn("[managed-pi] cancellation failed", error instanceof Error ? error.name : "UnknownError")); };
    signal.addEventListener("abort", onAbort, { once: true });
    let stage: "route" | "input" | "admission" | "tool_setup" | "run_spec" | "worker_dispatch" = "route";
    try {
      run.isolated = deps.isolatedChat?.select({ ownerId: input.owner.ownerId, chatId: input.chatId, modelId: input.selection.model }) ?? false;
      if (run.isolated && (input.resumeState || input.continuationId || input.selection.instanceId !== "matrix_pi_default"
        || input.parts.some(part => part.type !== "text"))) throw new BotRouteError("model_unavailable");
      const resolved = await resolveManagedPiSelection(input.selection, input.owner.ownerId, deps);
      if (signal.aborted || run.stopping) return { type: "run.completed", outcome: "aborted" };
      if (run.isolated) resolved.route = { ...resolved.route, maxOutputTokens: 256 };
      stage = "input";
      run.inputs = await prepareBotInputs({ homePath: deps.homePath, expectedOwnerId: deps.expectedOwnerId, ownerId: input.owner.ownerId, chatId: input.chatId, runId: input.runId, history: run.isolated ? undefined : deps.inputHistory, parts: input.parts, route: resolved.route, imageTotalMaximum: resolved.accessSourceId === "matrix_included" ? BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES : undefined, signal,
        assertActive: () => { if (run.stopping || run.finished || active.get(input.runId) !== run) throw new BotBrokerActionError("stale_generation"); } });
      await run.inputs.revalidate();
      stage = "admission";
      run.binding = await deps.admission.admit({ ownerId: input.owner.ownerId, chatId: input.chatId, runId: input.runId, resolved });
      if (signal.aborted || run.stopping) return { type: "run.completed", outcome: "aborted" };
      run.inputs.bind(run.binding);
      const isolatedTurn = await deps.isolatedChat?.claim(run.binding);
      stage = "tool_setup";
      if (!run.isolated) await deps.ownerTools?.open(run.binding, event => run.queue.push({ kind: "canonical", event }));
      stage = "run_spec";
      run.spec = BotRunSpecSchema.parse({ route: resolved.route,
        systemPrompt: await systemPrompt(input),
        capabilities: run.binding.capabilities, limits: run.isolated ? { maxToolActions: 1, maxInferenceCalls: 1 } : limits,
        ...(isolatedTurn ? { isolatedTurn } : {}),
        turn: { kind: "prompt", text: run.inputs.prompt(input.prompt), ...(run.inputs.imageCount ? { imageCount: run.inputs.imageCount } : {}) } });
      run.queue.push({ kind: "state", state: { runtimeHandle: run.binding.runtimeHandle, executionGeneration: run.binding.executionGeneration } });
      if (signal.aborted || run.stopping) return { type: "run.completed", outcome: "aborted" };
      await run.inputs.revalidate();
      await deps.assertSource?.(run.binding, signal);
      if (signal.aborted || run.stopping) return { type: "run.completed", outcome: "aborted" };
      stage = "worker_dispatch";
      const reply = await deps.host.client.runBot({ runtimeHandle: run.binding.runtimeHandle, executionGeneration: run.binding.executionGeneration,
        command: { version: 1, kind: "bot.run", runId: input.runId } });
      const outcome = reply.ok ? BotRunOutcomeSchema.safeParse(reply.reply) : undefined;
      if (outcome?.success && outcome.data.runId === input.runId && outcome.data.status === "completed") return { type: "run.completed", outcome: "completed" };
      if (signal.aborted || run.stopping) return { type: "run.completed", outcome: "aborted" };
      if (!reply.ok) {
        const transportError = TransportErrorSchema.safeParse(reply.error);
        throw new ManagedPiWorkerFailure({ stage: "worker_transport", error: transportError.success ? transportError.data : "unknown" });
      }
      if (!outcome?.success) throw new ManagedPiWorkerFailure({ stage: "worker_invalid_reply" });
      if (outcome.data.runId !== input.runId) throw new ManagedPiWorkerFailure({ stage: "worker_run_mismatch" });
      throw new ManagedPiWorkerFailure({ stage: "worker_outcome", status: outcome.data.status,
        failureCode: outcome.data.failureCode ?? null, blockedReason: outcome.data.blockedReason ?? null, toolActions: outcome.data.toolActions });
    } catch (error: unknown) {
      if (signal.aborted || run.stopping) return { type: "run.completed", outcome: "aborted" };
      console.warn("[managed-pi] run failed", error instanceof ManagedPiWorkerFailure ? error.diagnostic
        : error instanceof ManagedPiPersonalityError ? { stage, error: "personality_unavailable", category: error.code }
        : { stage, error: diagnosticErrorName(error) });
      if (run.fundedFailure && error instanceof ManagedPiWorkerFailure && error.diagnostic.stage === "worker_outcome"
        && error.diagnostic.status === "failed" && error.diagnostic.failureCode === "unavailable") {
        return { type: "run.completed", outcome: "failed", error: fundedChatError(run.fundedFailure) };
      }
      return { type: "run.completed", outcome: "failed", error: {
        code: stage === "input" ? "resource_unavailable" : error instanceof BotRouteError ? "model_unavailable" : "run_failed",
        safeMessage: stage === "input" ? "The attachments could not be read. Attach the files again, using PNG, JPEG or WebP images up to 2 MiB, or files up to 1 MiB." : error instanceof BotRouteError ? "The selected Matrix AI model is unavailable. Check Agents & providers." : "Matrix AI could not finish this request. Try again.",
        retryable: true, recoveryActions: ["retry"],
      } };
    } finally {
      run.inputs?.dispose();
      await deps.ownerTools?.closeRun(input.runId).catch((error: unknown) => console.warn("[managed-pi] tool close failed", error instanceof Error ? error.name : "UnknownError"));
      run.finished = true; if (run.grace) clearTimeout(run.grace); signal.removeEventListener("abort", onAbort);
      if (run.binding) await deps.admission.release(run.binding.runtimeHandle).catch((error: unknown) => console.warn("[managed-pi] release failed", error instanceof Error ? error.name : "UnknownError"));
    }
  }
  const runs: BotRunSource = {
    async loadRunSpec(binding) {
      const run = active.get(binding.runId);
      if (!isManagedPiBinding(binding) || !run?.spec || run.stopping || run.finished || run.ownerId !== binding.ownerId || run.chatId !== binding.chatId
        || run.binding?.runtimeHandle !== binding.runtimeHandle || run.binding.executionGeneration !== binding.executionGeneration) throw new BotBrokerActionError("stale_generation");
      return run.spec;
    },
    async readImageChunk(binding, request) {
      const run = active.get(binding.runId);
      if (!isManagedPiBinding(binding) || !run?.inputs) throw new BotBrokerActionError("stale_generation");
      run.inputs.assertAuthorized(binding);
      await deps.assertSource?.(binding, run.signal!);
      const chunk = await run.inputs.readImageChunk(binding, request);
      await deps.assertSource?.(binding, run.signal!);
      run.inputs.assertAuthorized(binding);
      return chunk;
    },
  };
  const events: BotEventSink = {
    async publish(binding, event) {
      const run = active.get(binding.runId);
      if (!isManagedPiBinding(binding) || !run || run.ownerId !== binding.ownerId || run.chatId !== binding.chatId) throw new BotBrokerActionError("stale_generation");
      run.queue.push({ kind: "worker", event: event.event });
    },
  };
  const adapter: CanonicalChatProviderAdapter<State> = {
    driverKind: "matrix_pi", stateSchemaVersion: 1,
    parseState: (value) => StateSchema.parse(value), serializeState: (value) => StateSchema.parse(value),
    async *start(value) {
      const input = parseCanonicalProviderRunInput(value);
      if (input.owner.type !== "personal" || input.sharedScopeId || input.parts.some((part) => part.type !== "text" && part.type !== "attachment_reference" && !(part.type === "resource_reference" && ["agent", "chat"].includes(part.resource.kind) && input.context))) throw new Error("Unsupported Matrix AI input");
      if (active.has(input.runId) || active.size >= BOT_RUNTIME_REGISTRY_CAPACITY) throw new Error("Matrix AI capacity unavailable");
      const run: Active = { ownerId: input.owner.ownerId, chatId: input.chatId, stopping: false, finished: false, isolated: false, queue: createCanonicalCliEventQueue<Event>(2048) };
      active.set(input.runId, run);
      const result = execute(input, run).finally(() => { active.delete(input.runId); deps.forgetRun(input.runId); run.queue.finish(); });
      let drained = false; let activities = 0;
      // Worker starts are capped at60; terminal events evict and run exit drains.
      const pendingTools = new Map<string, Extract<BotEvent["event"], { type: "tool_progress" }>>();
      const toolFrames = new Map<string, number>(); // At most60 identities per turn, erased at exit.
      try {
        for await (const item of run.queue.values()) {
          if (item.kind === "canonical") { yield item.event; continue; }
          if (item.kind === "state") { yield { type: "state.updated", state: item.state }; continue; }
          if (activities >= MAX_BOT_ACTIVITY_EVENTS && ["tool_progress", "activity"].includes(item.event.type)) continue;
          if (item.event.type === "tool_progress") {
            const progress = item.event;
            const previous = pendingTools.get(progress.toolCallId);
            if (progress.phase === "started") {
              if (toolFrames.has(progress.toolCallId) || toolFrames.size >= 60) continue;
              toolFrames.set(progress.toolCallId, 0);
            } else if (!previous) continue;
            if (progress.phase === "updated") {
              const updates = toolFrames.get(progress.toolCallId) ?? 0;
              if (updates >= 3) continue;
              toolFrames.set(progress.toolCallId, updates + 1);
            }
            if (["started", "updated"].includes(progress.phase)) pendingTools.set(progress.toolCallId, progress);
            else pendingTools.delete(progress.toolCallId);
          }
          for (const event of mapBotEvent(item.event, { toolOutputKey: deps.toolOutputKey })) {
            if (["tool.progress", "agent.activity"].includes(event.type) && ++activities > MAX_BOT_ACTIVITY_EVENTS) continue;
            yield CanonicalProviderRunEventSchema.parse(event);
          }
        }
        drained = true;
      } finally { if (!drained) await stop(input.runId); }
      const terminal = await result;
      for (const progress of terminal.type === "run.completed" && terminal.outcome === "completed" ? [] : pendingTools.values()) {
        for (const event of mapBotEvent({ ...progress, phase: terminal.type === "run.completed" && terminal.outcome === "aborted" ? "cancelled" : "failed",
          ...(progress.display ? { display: { ...progress.display, output: "The tool ended without a confirmed result." } } : {}) }, { toolOutputKey: deps.toolOutputKey })) yield event;
      }
      pendingTools.clear(); toolFrames.clear();
      yield terminal;
    },
    async cancel(input) { const run = active.get(input.runId); if (run && run.ownerId === input.owner.ownerId && run.chatId === input.chatId) await stop(input.runId); },
    async submitApproval(input) {
      const run = active.get(input.runId);
      if (!deps.ownerTools || !run || run.isolated || run.ownerId !== input.owner.ownerId || input.owner.type !== "personal" || run.chatId !== input.chatId || run.stopping || run.finished) throw new Error("Approval unavailable");
      await deps.ownerTools.submit(input);
    },
    async steer(input) {
      const run = active.get(input.runId);
      if (!run?.binding || run.isolated || run.ownerId !== input.owner.ownerId || run.chatId !== input.chatId || run.stopping) throw new Error("Matrix AI run unavailable");
      assertTextOnlySteering(input.parts);
      const reply = await deps.host.client.runBot({ runtimeHandle: run.binding.runtimeHandle, executionGeneration: run.binding.executionGeneration,
        command: { version: 1, kind: "bot.steer", runId: input.runId, text: input.prompt.slice(0, 8192) } });
      if (!reply.ok) throw new Error("Matrix AI steering unavailable");
    },
    async recover(input) { await deps.ownerTools?.closeRun(input.runId); await deps.admission.release(input.state.runtimeHandle); return { outcome: "failed", messages: [] }; },
  };
  return { adapter, runs, events,
    async readSubmittedArtifact(binding: PiRuntimeBinding, args: Extract<import("@matrix-os/contracts").BotToolRequest, { capability: "artifact.read" }>["args"]) {
      const run = active.get(binding.runId);
      if (!isManagedPiBinding(binding) || !run?.inputs) throw new BotBrokerActionError("stale_generation");
      run.inputs.assertAuthorized(binding);
      await deps.assertSource?.(binding, run.signal!);
      const result = await run.inputs.readArtifact(binding, args);
      await deps.assertSource?.(binding, run.signal!);
      run.inputs.assertAuthorized(binding);
      return result;
    },
    /** Only the registered gateway broker calls this; never derived from SDK text or worker events. */
    recordFundedFailure(binding: PiRuntimeBinding, reason: FundedChatFailureReason | undefined) {
      if (!isManagedPiBinding(binding)) return;
      const run = active.get(binding.runId);
      if (!run || run.finished || run.stopping || run.ownerId !== binding.ownerId || run.chatId !== binding.chatId
        || run.binding?.runtimeHandle !== binding.runtimeHandle || run.binding.executionGeneration !== binding.executionGeneration) return;
      run.fundedFailure = reason;
    },
    async close() { await Promise.all([...active.keys()].map(stop)); } };
}
