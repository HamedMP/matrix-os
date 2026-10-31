import { createManagedPiRoutineSource, type ManagedPiRoutineSource, type ManagedRoutineCliPort } from "./managed-pi-routine-source.js";
import type { BotInputHistoryReader } from "../bots/historical-input.js";
import { createBotWorkerDrain } from "../bots/worker-drain.js";
import { BOT_ATTACHMENT_UNAVAILABLE_MESSAGE, BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES } from "@matrix-os/contracts";
import { prepareSteerableBotInputs, type SteerableBotInputs } from "../bots/steerable-input.js";
import { deliverAcknowledgedSteer } from "./steering-delivery.js";
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
import { awaitManagedPiCleanup, createManagedPiRunCancellation } from "./managed-pi-cancellation.js";

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
  stopping: boolean; stopCause?: "cancelled" | "lease_lost"; finished: boolean;
  worker?: ReturnType<typeof createBotWorkerDrain>;
  renewal?: { stop(): Promise<void> };
  routineSource?: ManagedPiRoutineSource;
  renewalStopped?: Promise<void>;
  fundedFailure?: FundedChatFailureReason;
  isolated: boolean;
  inputs?: SteerableBotInputs;
  signal?: AbortSignal;
  cancellation: AbortController;
  releasing?: Promise<void>;
}

/** Two policies use one pinned worker/broker. Ordinary Chat has no recipe or bot grants. */
export function createManagedPiRuntime(deps: {
  toolOutputKey?: Buffer;
  routineCli?: ManagedRoutineCliPort;
  routineSignal?(binding: ManagedPiRuntimeBinding): AbortSignal | null;
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
  if (deps.routineCli && (!deps.homePath || typeof deps.routineSignal !== "function" || typeof deps.routineCli.runtime?.registerManagedChat !== "function")) throw new Error("Routine source dependencies unavailable");
  const systemPrompt = createManagedPiSystemPrompt(deps.personality);
  const limits = readTrustedBotRunLimits();
  const active = new Map<string, Active>(); // capacity/terminal eviction below; renewal failure stops busy runs.
  function stopRenewal(run: Active): Promise<void> {
    if (!run.renewal) return Promise.resolve();
    return run.renewalStopped ??= run.renewal.stop();
  }
  function release(run: Active): Promise<void> {
    if (!run.binding) return Promise.resolve();
    return run.releasing ??= (async () => {
      await stopRenewal(run);
      await deps.admission.release(run.binding!.runtimeHandle);
    })().catch((error: unknown) => console.warn("[managed-pi] release failed", diagnosticErrorName(error)));
  }
  async function stop(runId: string, cause: "cancelled" | "lease_lost" = "cancelled"): Promise<void> {
    const run = active.get(runId); if (!run || run.finished || run.stopping) return;
    run.stopping = true; run.stopCause = cause;
    run.routineSource?.end();
    if (cause === "cancelled") run.worker?.stop();
    else if (run.worker) void run.worker.release().catch((error: unknown) => {
      console.warn("[managed-pi] revoked runtime release failed", diagnosticErrorName(error));
    });
    // Mark the lease inactive before cancelling or releasing: an in-flight renew
    // cannot reauthorize this run after its terminal path starts.
    void stopRenewal(run).catch((error: unknown) => console.warn("[managed-pi] renewal stop failed", diagnosticErrorName(error)));
    run.cancellation.abort();
    run.inputs?.dispose();
    const binding = run.binding;
    if (binding) deps.cancelInference(binding);
    // Local approvals are revoked synchronously; Platform revocation is bounded and must not delay Stop.
    void deps.ownerTools?.closeRun(runId).catch((error: unknown) => console.warn("[managed-pi] tool close failed", error instanceof Error ? error.name : "UnknownError"));
    if (!binding) return;
    await awaitManagedPiCleanup(async () => {
      let delivered = false;
      try { delivered = (await deps.host.client.runBot({ ...binding, command: { version: 1, kind: "bot.cancel", runId } })).ok; }
      catch (error: unknown) { console.warn("[managed-pi] cancel delivery failed", diagnosticErrorName(error)); }
      if (!delivered) await (run.worker?.release() ?? release(run));
    });
  }
  async function execute(input: CanonicalProviderRunInput<State>, run: Active): Promise<CanonicalProviderRunEvent> {
    const cancellation = createManagedPiRunCancellation([input.signal, deps.lifetime, run.cancellation.signal]);
    const { signal } = cancellation;
    const cancelled = (): CanonicalProviderRunEvent => run.stopCause === "lease_lost"
      ? { type: "run.completed", outcome: "failed", error: { code: "run_failed", safeMessage: "Matrix AI could not finish this request. Check progress before trying again.", retryable: false, recoveryActions: [] } }
      : { type: "run.completed", outcome: "aborted" };
    run.signal = signal;
    const onAbort = () => { void stop(input.runId).catch((error: unknown) => console.warn("[managed-pi] cancellation failed", error instanceof Error ? error.name : "UnknownError")); };
    signal.addEventListener("abort", onAbort, { once: true });
    let stage: "route" | "input" | "admission" | "tool_setup" | "run_spec" | "worker_dispatch" = "route";
    try {
      signal.throwIfAborted();
      await cancellation.wait(() => Promise.all([...active.values()].filter(previous => previous !== run && previous.stopping
        && previous.ownerId === input.owner.ownerId && previous.chatId === input.chatId).map(previous => previous.worker?.done)));
      run.isolated = deps.isolatedChat?.select({ ownerId: input.owner.ownerId, chatId: input.chatId, modelId: input.selection.model }) ?? false;
      if (run.isolated && (input.resumeState || input.continuationId || input.selection.instanceId !== "matrix_pi_default"
        || input.parts.some(part => part.type !== "text"))) throw new BotRouteError("model_unavailable");
      const resolved = await cancellation.wait(() => resolveManagedPiSelection(input.selection, input.owner.ownerId, deps));
      if (signal.aborted || run.stopping) return cancelled();
      if (run.isolated) resolved.route = { ...resolved.route, maxOutputTokens: 256 };
      stage = "input";
      run.inputs = await cancellation.wait(() => prepareSteerableBotInputs({ homePath: deps.homePath, expectedOwnerId: deps.expectedOwnerId, ownerId: input.owner.ownerId, chatId: input.chatId, runId: input.runId, history: run.isolated ? undefined : deps.inputHistory, parts: input.parts, route: resolved.route, imageTotalMaximum: resolved.accessSourceId === "matrix_included" ? BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES : undefined, signal,
        assertActive: () => { if (run.stopping || run.finished || active.get(input.runId) !== run) throw new BotBrokerActionError("stale_generation"); } }), inputs => inputs.dispose());
      await cancellation.wait(() => run.inputs!.revalidate());
      stage = "admission";
      run.binding = await cancellation.wait(() => deps.admission.admit({ ownerId: input.owner.ownerId, chatId: input.chatId, runId: input.runId, resolved }), binding => deps.admission.release(binding.runtimeHandle));
      if (signal.aborted || run.stopping) return cancelled();
      run.renewal = deps.admission.startRenewal(run.binding, error => {
        console.warn("[managed-pi] runtime renewal failed", diagnosticErrorName(error));
        void stop(input.runId, "lease_lost").catch((stopError: unknown) =>
          console.warn("[managed-pi] lease loss cleanup failed", diagnosticErrorName(stopError)));
      });
      run.inputs.bind(run.binding);
      if (!run.isolated && deps.routineCli && run.binding.capabilities.includes("routine.cli")) {
        const binding = run.binding, bindingSignal = deps.routineSignal!(run.binding);
        if (!bindingSignal || bindingSignal.aborted) throw new BotBrokerActionError("stale_generation");
        run.routineSource = createManagedPiRoutineSource({ ...deps.routineCli, input, binding, signal: AbortSignal.any([signal, bindingSignal]), homePath: deps.homePath!,
          current: () => active.get(input.runId) === run && !run.stopping && !run.finished && !signal.aborted,
          publish: event => run.queue.push({ kind: "canonical", event }) });
      }
      const isolatedTurn = await cancellation.wait(async () => deps.isolatedChat?.claim(run.binding!));
      stage = "tool_setup";
      if (!run.isolated) await cancellation.wait(async () => deps.ownerTools?.open(run.binding!, event => run.queue.push({ kind: "canonical", event })), async () => deps.ownerTools?.closeRun(input.runId));
      stage = "run_spec";
      run.spec = BotRunSpecSchema.parse({ route: resolved.route,
        systemPrompt: await cancellation.wait(() => systemPrompt(input)),
        capabilities: run.binding.capabilities, limits: run.isolated ? { maxToolActions: 1, maxInferenceCalls: 1 } : limits,
        ...(isolatedTurn ? { isolatedTurn } : {}),
        turn: { kind: "prompt", text: run.inputs.prompt(input.prompt), ...(run.inputs.imageCount ? { imageCount: run.inputs.imageCount } : {}) } });
      run.queue.push({ kind: "state", state: { runtimeHandle: run.binding.runtimeHandle, executionGeneration: run.binding.executionGeneration } });
      if (signal.aborted || run.stopping) return cancelled();
      await cancellation.wait(() => run.inputs!.revalidate());
      await cancellation.wait(async () => deps.assertSource?.(run.binding!, signal));
      if (signal.aborted || run.stopping) return cancelled();
      stage = "worker_dispatch";
      run.worker = createBotWorkerDrain({ release: () => release(run),
        onError: error => console.warn("[managed-pi] grace release failed", diagnosticErrorName(error)) });
      const reply = await cancellation.waitBusy(() => run.worker!.track(deps.host.client.runBot({ runtimeHandle: run.binding!.runtimeHandle, executionGeneration: run.binding!.executionGeneration,
        command: { version: 1, kind: "bot.run", runId: input.runId }, signal: run.worker!.signal })));
      if (signal.aborted || run.stopping) return cancelled();
      const outcome = reply.ok ? BotRunOutcomeSchema.safeParse(reply.reply) : undefined;
      if (outcome?.success && outcome.data.runId === input.runId && outcome.data.status === "completed") return { type: "run.completed", outcome: "completed" };
      if (!reply.ok) {
        const transportError = TransportErrorSchema.safeParse(reply.error);
        throw new ManagedPiWorkerFailure({ stage: "worker_transport", error: transportError.success ? transportError.data : "unknown" });
      }
      if (!outcome?.success) throw new ManagedPiWorkerFailure({ stage: "worker_invalid_reply" });
      if (outcome.data.runId !== input.runId) throw new ManagedPiWorkerFailure({ stage: "worker_run_mismatch" });
      throw new ManagedPiWorkerFailure({ stage: "worker_outcome", status: outcome.data.status,
        failureCode: outcome.data.failureCode ?? null, blockedReason: outcome.data.blockedReason ?? null, toolActions: outcome.data.toolActions });
    } catch (error: unknown) {
      if (signal.aborted || run.stopping) return cancelled();
      console.warn("[managed-pi] run failed", error instanceof ManagedPiWorkerFailure ? error.diagnostic
        : error instanceof ManagedPiPersonalityError ? { stage, error: "personality_unavailable", category: error.code }
        : { stage, error: diagnosticErrorName(error) });
      if (run.fundedFailure && error instanceof ManagedPiWorkerFailure && error.diagnostic.stage === "worker_outcome"
        && error.diagnostic.status === "failed" && error.diagnostic.failureCode === "unavailable") {
        return { type: "run.completed", outcome: "failed", error: fundedChatError(run.fundedFailure) };
      }
      return { type: "run.completed", outcome: "failed", error: {
        code: stage === "input" ? "resource_unavailable" : error instanceof BotRouteError ? "model_unavailable" : "run_failed",
        safeMessage: stage === "input" ? BOT_ATTACHMENT_UNAVAILABLE_MESSAGE : error instanceof BotRouteError ? "The selected Matrix AI model is unavailable. Check Agents & providers." : "Matrix AI could not finish this request. Try again.",
        retryable: true, recoveryActions: ["retry"],
      } };
    } finally {
      run.routineSource?.end();
      run.inputs?.dispose();
      run.finished = true; signal.removeEventListener("abort", onAbort);
      await stopRenewal(run);
      if (run.stopping && run.worker) run.worker.stop();
      // closeRun revokes local approvals synchronously; do not let remote revocation delay runtime stop.
      await awaitManagedPiCleanup(async () => Promise.all([
        run.routineSource?.close(),
        deps.ownerTools?.closeRun(input.runId),
        ...(!run.stopping || !run.worker ? [run.worker?.release() ?? release(run)] : []),
      ]));
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
      if (!isManagedPiBinding(binding) || !run || run.stopping || run.finished
        || run.ownerId !== binding.ownerId || run.chatId !== binding.chatId
        || run.binding?.runtimeHandle !== binding.runtimeHandle
        || run.binding.executionGeneration !== binding.executionGeneration) throw new BotBrokerActionError("stale_generation");
      run.routineSource?.observe(event.event);
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
      const run: Active = { ownerId: input.owner.ownerId, chatId: input.chatId, stopping: false, finished: false, isolated: false, cancellation: new AbortController(), queue: createCanonicalCliEventQueue<Event>(2048) };
      active.set(input.runId, run);
      const result = execute(input, run).finally(() => {
        run.queue.finish();
        const forget = () => { active.delete(input.runId); deps.forgetRun(input.runId); };
        if (run.stopping && run.worker) void run.worker.done.then(forget).catch((error: unknown) => {
          console.warn("[managed-pi] run cleanup failed", diagnosticErrorName(error));
        });
        else forget();
      });
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
      if (!run?.binding || run.isolated || input.owner.type !== "personal" || run.ownerId !== input.owner.ownerId
        || run.chatId !== input.chatId || run.stopping || run.finished || run.signal?.aborted) throw new Error("Matrix AI run unavailable");
      if (!run.inputs) throw new Error("Matrix AI steering unavailable");
      const binding = run.binding;
      run.routineSource?.end();
      const accepted = await run.inputs.steer(binding, input.parts, input.prompt, async payload => {
        await deps.assertSource?.(binding, run.signal!);
        run.inputs!.assertAuthorized(binding);
        return deliverAcknowledgedSteer(() => deps.host.client.runBot({ runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration,
          command: { version: 1, kind: "bot.steer", runId: input.runId, ...payload } }));
      });
      if (!accepted) throw new Error("Matrix AI steering unavailable");
    },
    async recover(input) { await deps.ownerTools?.closeRun(input.runId); await deps.admission.release(input.state.runtimeHandle); return { outcome: "failed", messages: [] }; },
  };
  return { adapter, runs, events,
    async executeRoutine(binding: PiRuntimeBinding, operation: import("@matrix-os/contracts").RoutineCliOperation, toolCallId: string, signal: AbortSignal) {
      const run = active.get(binding.runId);
      if (!isManagedPiBinding(binding) || !run?.routineSource || run.stopping || run.finished) throw new BotBrokerActionError("stale_generation");
      await deps.assertSource?.(binding, signal);
      return run.routineSource.execute(binding, operation, toolCallId, signal);
    },
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
    async close() { await awaitManagedPiCleanup(async () => Promise.all([...active].map(async ([runId, run]) => {
      await stop(runId);
      await run.worker?.done;
    }))); } };
}
