import { AsyncLocalStorage } from "node:async_hooks";
import type { Duplex } from "node:stream";
import { z } from "zod/v4";
import { RoutineCliEnvelopeSchema, RoutineCliOperationSchema, type RoutineCliOperation } from "@matrix-os/contracts/routine-cli";
import { boundedOperation } from "../bounded-operation.js";
import { createFixedNativeRoutineCliInvoker } from "../bots/routine-cli-invoker.js";
import { routineActionHash } from "../bots/routine-action-source-registry.js";
import type { RoutineCliVerifiedInvocation } from "../bots/routine-cli-source.js";
import { createCodingOutputBuffer } from "../coding-agents/coding-output-buffer.js";
import type { NativeRoutineCliPort } from "./claude-routine-execution.js";
import type { CanonicalProviderRunEvent, CanonicalProviderRunInput } from "./provider-adapter.js";

const ref = z.string().min(1).max(512);
const Context = z.object({ sessionId: ref, toolCallId: ref }).strict();
const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call"), id: z.uuid(), context: Context, operation: RoutineCliOperationSchema }).strict(),
  z.object({ type: z.literal("cancel"), id: z.uuid() }).strict(),
]);
const execution = new AsyncLocalStorage<PiRoutineSource>();
export function nativePiRoutineSource(): PiRoutineSource | undefined { return execution.getStore(); }
export function createPiRoutineSources(port: NativeRoutineCliPort | undefined, homePath: string) {
  if (port && (typeof port.runtime?.registerChat !== "function" || typeof port.binPath !== "string" || typeof port.endpoint !== "string")) throw new Error("Routine source dependencies unavailable");
  const sources = new Set<PiRoutineSource>(); // <=64, retain until late registration/revocation drains.
  return { open(input: CanonicalProviderRunInput, publish: (event: CanonicalProviderRunEvent) => void) {
    if (!port || sources.size >= 64) return undefined;
    const source = createPiRoutineSource({ ...port, input, homePath, publish }); sources.add(source);
    return { withContext: <T>(work: () => T) => execution.run(source, work), async close() {
      await source.close(); void source.drained().then(() => sources.delete(source));
    } };
  } };
}
function argv(operation: RoutineCliOperation) {
  switch (operation.operation) {
    case "list": return { args: ["list"] };
    case "show": return { args: ["show", operation.routineId] };
    case "request": return { args: ["request", operation.requestId] };
    case "propose": return { args: ["propose", "--input", "-", "--request-id", operation.requestId], stdin: JSON.stringify(operation.proposal) };
    default: return { args: [operation.operation, operation.routineId, "--revision", String(operation.baseRevision), "--request-id", operation.requestId] };
  }
}
function unknown(operation: RoutineCliOperation) {
  return JSON.stringify(["propose", "pause", "resume", "archive"].includes(operation.operation) && "requestId" in operation
    ? { v: 1, ok: true, data: { kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true } }
    : { v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } });
}
/** One exact native RPC child/generation; private FD context and independently observed native events must rendezvous.
 * No public source selector, native/model session lookup, generic owner token or direct backend call. */
function createPiRoutineSource(options: NativeRoutineCliPort & { input: CanonicalProviderRunInput; homePath: string; publish(event: CanonicalProviderRunEvent): void }) {
  const controller = new AbortController(), signal = AbortSignal.any([options.input.signal, controller.signal]);
  let ended = false, sessionId: string | undefined, cwd: string | undefined, socket: Duplex | undefined, started = false, turn = 0;
  let sourceId: string | undefined, registration: ReturnType<NativeRoutineCliPort["runtime"]["registerChat"]> | undefined;
  const calls = new Map<string, { status: "running" | "terminal"; digest?: string; turn: number }>(); // <=512, irreversible tombstones; cap ends source.
  const seen = new Set<string>(); // <=1024 FD IDs/call IDs, never evict/replay.
  const invocations = new Map<string, { key: string; signal: AbortSignal; digest: string }>(); // <=512 retained for committed claim validation.
  const actions = new Map<string, { controller: AbortController; key: string; wake?: () => void }>(); // <=8, including rendezvous waits.
  const invokers = new Set<ReturnType<typeof createFixedNativeRoutineCliInvoker>>(); // <=8, removed after close.
  const cleanup = new Set<Promise<unknown>>(); // <=8 actions +8 closes +registration/revoke.
  const live = () => !ended && !signal.aborted;
  function observe(work: Promise<unknown>) {
    cleanup.add(work); void work.catch(error => console.warn("[pi-routines] Cleanup unavailable", error instanceof Error ? error.name : "UnknownError")).finally(() => cleanup.delete(work));
  }
  function end() {
    if (ended) return; ended = true; controller.abort(); clearTimeout(timer); options.input.signal.removeEventListener("abort", end);
    for (const action of actions.values()) action.controller.abort(); socket?.destroy();
    for (const invoker of invokers) observe(invoker.close());
    if (registration) observe(registration.then(source => source.revoke()));
  }
  const timer = setTimeout(end, 30 * 60_000); timer.unref(); options.input.signal.addEventListener("abort", end, { once: true });
  function current(invocation?: RoutineCliVerifiedInvocation) {
    if (!live()) return false;
    if (!invocation) return true;
    const actual = invocations.get(invocation.invocationId);
    if (!actual || invocation.sourceId !== sourceId || invocation.operationDigest !== actual.digest) return false;
    // accepted:true is reconstructed only by validateAcceptedWithin from consumed cap + real committed receipt.
    return invocation.accepted === true || calls.get(actual.key)?.status === "running" && !actual.signal.aborted;
  }
  function send(id: string, context: z.infer<typeof Context>, result: string) {
    if (!live() || !socket || socket.destroyed) return;
    const text = JSON.stringify({ type: "result", id, context, result }) + "\n";
    if (Buffer.byteLength(result) > 131072 || Buffer.byteLength(text) > 196608 || socket.writableLength > 196608) { end(); return; }
    try { socket.write(text); } catch (error) { console.warn("[pi-routines] Write unavailable", error instanceof Error ? error.name : "UnknownError"); end(); }
  }
  function terminal(key: string) {
    calls.set(key, { status: "terminal", turn });
    for (const action of actions.values()) if (action.key === key) action.controller.abort();
  }
  function notify() { for (const action of actions.values()) action.wake?.(); }
  async function call(frame: Extract<z.infer<typeof Frame>, { type: "call" }>) {
    const key = frame.context.toolCallId, digest = routineActionHash(frame.operation);
    if (!live() || !sessionId || frame.context.sessionId !== sessionId || seen.has(frame.id) || seen.has(key)) { send(frame.id, frame.context, unknown(frame.operation)); return; }
    if (seen.size >= 1024) { end(); return; }
    seen.add(frame.id); seen.add(key);
    if (actions.size >= 8) { send(frame.id, frame.context, unknown(frame.operation)); return; }
    const action = { controller: new AbortController(), key, wake: undefined as (() => void) | undefined };
    const actionSignal = AbortSignal.any([signal, action.controller.signal]); actions.set(frame.id, action);
    const deadline = setTimeout(() => action.controller.abort(), 120_000); deadline.unref();
    let invoker: ReturnType<typeof createFixedNativeRoutineCliInvoker> | undefined;
    try {
      const matched = await new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(wait); action.wake = undefined; actionSignal.removeEventListener("abort", abort); resolve(value); };
        const abort = () => finish(false);
        const wait = setTimeout(() => { action.controller.abort(); finish(false); }, 2000); wait.unref();
        action.wake = () => {
          const actual = calls.get(key);
          if (!live() || actionSignal.aborted || actual?.status === "terminal" || actual?.digest !== undefined && actual.digest !== digest) finish(false);
          else if (started && turn > 0 && actual?.status === "running" && actual.turn === turn) finish(true);
        };
        actionSignal.addEventListener("abort", abort, { once: true }); action.wake();
      });
      if (!matched || !live() || actionSignal.aborted) { send(frame.id, frame.context, unknown(frame.operation)); return; }
      registration ??= options.runtime.registerChat({ input: options.input, provider: "pi", signal, current, publish: options.publish });
      const registered = await boundedOperation(() => registration!, 10_000, actionSignal);
      if (!live() || actionSignal.aborted) { send(frame.id, frame.context, unknown(frame.operation)); return; }
      sourceId = registered.reference.sourceId;
      invoker = createFixedNativeRoutineCliInvoker({ binPath: options.binPath, endpoint: options.endpoint, cwd, homePath: options.homePath,
        authorize(input) {
          if (invocations.size >= 512) { end(); return Promise.resolve(false); }
          invocations.set(input.invocationId, { key, signal: actionSignal, digest: routineActionHash(input.operation) });
          return current({ sourceId: sourceId!, invocationId: input.invocationId, operationDigest: routineActionHash(input.operation) }) ? registered.authorize(input) : Promise.resolve(false);
        }, issue: registered.issue, cancel: registered.cancel, timeoutMs: 120_000 });
      invokers.add(invoker);
      const result = RoutineCliEnvelopeSchema.parse(await invoker.invoke({ ...argv(frame.operation), expectedOperation: frame.operation, signal: actionSignal }));
      send(frame.id, frame.context, actionSignal.aborted ? unknown(frame.operation) : JSON.stringify(result));
    } catch (error) { console.warn("[pi-routines] Action unavailable", error instanceof Error ? error.name : "UnknownError"); send(frame.id, frame.context, unknown(frame.operation)); }
    finally { clearTimeout(deadline); action.wake = undefined; if (invoker) { await invoker.close(); invokers.delete(invoker); } actions.delete(frame.id); }
  }
  const source = {
    current: live, end,
    attach(actual: Duplex) {
      if (socket || !live()) { actual.destroy(); return; } socket = actual;
      const frames = createCodingOutputBuffer(196608);
      actual.on("data", (chunk: Buffer) => {
        if (!live()) return;
        try { frames.push(chunk, line => {
          const parsed = Frame.safeParse(JSON.parse(line)); if (!parsed.success) { end(); return false; }
          if (parsed.data.type === "cancel") actions.get(parsed.data.id)?.controller.abort(); else observe(call(parsed.data)); return live();
        }); } catch (error) { console.warn("[pi-routines] Invalid frame", error instanceof Error ? error.name : "UnknownError"); end(); }
      });
      actual.once("end", end); actual.once("close", end); actual.once("error", end);
    },
    beforePrompt(actualSession: string, actualCwd: string) {
      if (!live() || sessionId || !ref.safeParse(actualSession).success) { end(); return false; }
      sessionId = actualSession; cwd = actualCwd; return true;
    },
    observeEvent(value: unknown) {
      if (!live() || !sessionId || !value || typeof value !== "object") return;
      const event = value as Record<string, unknown>;
      const message = event.message as { role?: unknown; stopReason?: unknown } | undefined;
      if (event.type === "message_end" && message?.role === "assistant" && ["error", "aborted"].includes(String(message.stopReason))) { end(); return; }
      if (["agent_end", "agent_settled", "error"].includes(String(event.type))) { end(); return; }
      if (event.type === "agent_start") { if (started) end(); else started = true; notify(); return; }
      if (event.type === "turn_start") { if (!started || ++turn > 512) end(); notify(); return; }
      if (event.type === "turn_end") { for (const [key, value] of calls) if (value.status === "running" && value.turn === turn) terminal(key); notify(); return; }
      if (event.toolName !== "matrix_routines" || !ref.safeParse(event.toolCallId).success || !["tool_execution_start", "tool_execution_end"].includes(String(event.type))) return;
      const key = event.toolCallId as string;
      if (calls.size >= 512 && !calls.has(key)) { end(); return; }
      if (calls.get(key)?.status === "terminal") return;
      const parsed = RoutineCliOperationSchema.safeParse(event.args);
      const digest = parsed.success ? routineActionHash(parsed.data) : undefined;
      if (event.type === "tool_execution_end" || event.parentToolCallId !== undefined || !started || turn < 1 || !digest
        || calls.get(key)?.digest !== undefined && calls.get(key)!.digest !== digest) terminal(key);
      else calls.set(key, { status: "running", digest, turn });
      notify();
    },
    drained: () => Promise.allSettled([...cleanup]),
    async close() { end(); try { await boundedOperation(() => source.drained(), 5000); } catch (error) { console.warn("[pi-routines] Drain unconfirmed", error instanceof Error ? error.name : "UnknownError"); } },
  };
  if (options.input.signal.aborted) end();
  return source;
}
export type PiRoutineSource = ReturnType<typeof createPiRoutineSource>;
