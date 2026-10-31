import { statSync } from "node:fs";
import { isAbsolute, basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RoutineCliOperationSchema, type BotEvent, type BotToolResult, type RoutineCliOperation } from "@matrix-os/contracts";
import { RoutineCliEndpointSchema, RoutineCliEnvelopeSchema } from "@matrix-os/contracts/routine-cli";
import { boundedOperation } from "../bounded-operation.js";
import { BotBrokerActionError } from "../bots/broker-actions.js";
import { createFixedNativeRoutineCliInvoker } from "../bots/routine-cli-invoker.js";
import type { RoutineCliRuntime } from "../bots/routine-cli-runtime.js";
import type { RoutineCliVerifiedInvocation } from "../bots/routine-cli-source.js";
import { routineActionHash } from "../bots/routine-action-source-registry.js";
import type { ManagedPiRuntimeBinding, PiRuntimeBinding } from "../bots/runtime-registry.js";
import type { CanonicalProviderRunEvent, CanonicalProviderRunInput } from "./provider-adapter.js";
export interface ManagedRoutineCliPort { runtime: Pick<RoutineCliRuntime, "registerManagedChat">; binPath: string; endpoint: string }
function command(operation: RoutineCliOperation) {
  switch (operation.operation) {
    case "list": return { args: ["list"] };
    case "show": return { args: ["show", operation.routineId] };
    case "request": return { args: ["request", operation.requestId] };
    case "propose": return { args: ["propose", "--input", "-", "--request-id", operation.requestId], stdin: JSON.stringify(operation.proposal) };
    default: return { args: [operation.operation, operation.routineId, "--revision", String(operation.baseRevision), "--request-id", operation.requestId] };
  }
}
function text(value: unknown): BotToolResult {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 131072) throw new BotBrokerActionError("unavailable");
  const content: { type: "text"; text: string }[] = [];
  for (let i = 0; i < encoded.length; i += 60 * 1024) content.push({ type: "text", text: encoded.slice(i, i + 60 * 1024) });
  return { ok: true, content };
}
/** One actual admitted managed worker incarnation. Broker callback identity is the registered binding,
 * not a native Pi session/PID, model labels, source ID, synthetic principal or Bot task. */
export function createManagedPiRoutineSource(options: ManagedRoutineCliPort & { input: CanonicalProviderRunInput;
  binding: ManagedPiRuntimeBinding; signal: AbortSignal; homePath: string; current(): boolean;
  publish(event: CanonicalProviderRunEvent): void }) {
  if (typeof options.runtime?.registerManagedChat !== "function" || !options.binPath || !options.endpoint || !options.homePath) throw new Error("Routine source dependencies unavailable");
  RoutineCliEndpointSchema.parse(options.endpoint);
  if (!isAbsolute(options.binPath) || basename(options.binPath) !== "matrix.mjs" || !statSync(options.binPath).isFile()
    || !isAbsolute(options.homePath) || !statSync(options.homePath).isDirectory()) throw new Error("Routine source dependencies unavailable");
  const binding = structuredClone(options.binding), controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const calls = new Map<string, { terminal: boolean; abort: AbortController }>(); // <=60/run; terminal tombstones never replay.
  const invocations = new Map<string, { callId: string; digest: string; signal: AbortSignal }>(); // <=60, retained for accepted claim.
  const invokers = new Set<ReturnType<typeof createFixedNativeRoutineCliInvoker>>(); // <=8 active; finally + close drain.
  const cleanup = new Set<Promise<unknown>>(); // <=60 invocation revocations +8 drains + registration.
  let activeCalls = 0;
  let sourceId: string | undefined, registration: ReturnType<RoutineCliRuntime["registerManagedChat"]> | undefined;
  const live = () => !signal.aborted && options.current();
  const observe = (work: Promise<unknown>) => {
    cleanup.add(work); void work.catch(error => console.warn("[managed-pi-routines] Cleanup unavailable", error instanceof Error ? error.name : "UnknownError")).finally(() => cleanup.delete(work));
  };
  const current = (invocation?: RoutineCliVerifiedInvocation) => {
    if (!live()) return false;
    if (!invocation) return true;
    const actual = invocations.get(invocation.invocationId);
    return !!actual && sourceId === invocation.sourceId && actual.digest === invocation.operationDigest
      && (invocation.accepted === true || !actual.signal.aborted && calls.get(actual.callId)?.terminal === false);
  };
  function terminal(id: string) {
    const call = calls.get(id);
    if (call?.terminal) return;
    if (call) { call.terminal = true; call.abort.abort(); }
    else if (calls.size < 60) calls.set(id, { terminal: true, abort: new AbortController() });
    else end();
    // Real unused capability revocation begins now, independently of child/process drainage.
    if (registration) for (const [invocationId, value] of invocations) if (value.callId === id) observe(registration.then(port => port.cancel({ invocationId, reason: "aborted" })));
  }
  function end() {
    if (controller.signal.aborted) return;
    controller.abort(); clearTimeout(timer); options.signal.removeEventListener("abort", end);
    for (const id of calls.keys()) terminal(id);
    if (registration) observe(registration.then(port => port.revoke()));
    for (const invoker of invokers) observe(invoker.close());
  }
  const timer = setTimeout(end, 30 * 60_000); timer.unref();
  options.signal.addEventListener("abort", end, { once: true });
  if (options.signal.aborted) end();
  return {
    end,
    observe(event: BotEvent["event"]) {
      if (event.type === "tool_progress" && event.capability === "routine.cli" && ["completed", "failed", "cancelled"].includes(event.phase)) terminal(event.toolCallId);
    },
    async execute(actual: PiRuntimeBinding, raw: RoutineCliOperation, callId: string, callSignal: AbortSignal): Promise<BotToolResult> {
      const operation = RoutineCliOperationSchema.parse(raw);
      if (!live() || !isDeepStrictEqual(actual, binding) || calls.has(callId) || calls.size >= 60 || activeCalls >= 8 || callSignal.aborted) throw new BotBrokerActionError("stale_generation");
      const call = { terminal: false, abort: new AbortController() }; calls.set(callId, call); activeCalls++;
      const actionSignal = AbortSignal.any([signal, callSignal, call.abort.signal, AbortSignal.timeout(120_000)]);
      const aborted = () => terminal(callId); actionSignal.addEventListener("abort", aborted, { once: true });
      let invoker: ReturnType<typeof createFixedNativeRoutineCliInvoker> | undefined;
      try {
        registration ??= options.runtime.registerManagedChat({ binding, input: options.input, signal, current, publish: options.publish });
        const registered = await boundedOperation(() => registration!, 10_000, actionSignal); sourceId = registered.reference.sourceId;
        if (!live() || actionSignal.aborted) throw new BotBrokerActionError("stale_generation");
        invoker = createFixedNativeRoutineCliInvoker({ binPath: options.binPath, endpoint: options.endpoint, cwd: options.homePath, homePath: options.homePath,
          authorize(input) {
            if (invocations.size >= 60 || !live() || actionSignal.aborted) return Promise.resolve(false);
            invocations.set(input.invocationId, { callId, digest: routineActionHash(input.operation), signal: actionSignal });
            return registered.authorize(input);
          }, issue: registered.issue, cancel: registered.cancel, timeoutMs: 120_000 });
        invokers.add(invoker);
        return text(RoutineCliEnvelopeSchema.parse(await invoker.invoke({ ...command(operation), expectedOperation: operation, signal: actionSignal })));
      } catch (error) {
        console.warn("[managed-pi-routines] Action unavailable", error instanceof Error ? error.name : "UnknownError");
        return text("requestId" in operation && operation.operation !== "request"
          ? { v: 1, ok: true, data: { kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true } }
          : { v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } });
      } finally {
        terminal(callId); activeCalls--; actionSignal.removeEventListener("abort", aborted);
        if (invoker) { await invoker.close(); invokers.delete(invoker); }
      }
    },
    async close() {
      end();
      try { await boundedOperation(() => Promise.allSettled([...cleanup]), 5000); }
      catch (error) { console.warn("[managed-pi-routines] Drain unconfirmed", error instanceof Error ? error.name : "UnknownError"); }
    },
  };
}
export type ManagedPiRoutineSource = ReturnType<typeof createManagedPiRoutineSource>;
