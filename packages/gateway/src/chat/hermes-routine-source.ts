import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod/v4";
import { boundedOperation } from "../bounded-operation.js";
import { createFixedNativeRoutineCliInvoker } from "../bots/routine-cli-invoker.js";
import { RoutineCliEnvelopeSchema } from "@matrix-os/contracts/routine-cli";
import { RoutineArgvSchema, routineUnknownResult } from "../coding-agents/managed-launch-protocol.mjs";
import type { NativeRoutineCliPort } from "./claude-routine-execution.js";
import type { CanonicalProviderRunInput, CanonicalProviderRunEvent } from "./provider-adapter.js";

export const HERMES_ROUTINE_TOOL = "matrix_routines";
export const HERMES_ROUTINE_PIN = "d337b736aa1e8ebecfab043842d13e4a2d2f48a3";
const ref = z.string().min(1).max(512);
const NativeContext = z.object({ task_id: ref, session_id: ref, turn_id: ref, tool_call_id: ref, api_request_id: ref }).strict();
const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), version: z.literal(1), pin: z.literal(HERMES_ROUTINE_PIN) }).strict(),
  z.object({ type: z.literal("enabled") }).strict(),
  z.object({ type: z.literal("call"), id: z.uuid(), context: NativeContext, intent: RoutineArgvSchema }).strict(),
  z.object({ type: z.literal("cancel"), id: z.uuid() }).strict(),
  z.object({ type: z.literal("end") }).strict(),
]);
const Catalog = z.object({ lazy: z.boolean().optional(), tools: z.record(z.string().max(128), z.array(z.string().max(256)).max(512)) });
/** One actual held Python child/FD. Native context is correlation only; no serialized source selector. */
export function createHermesRoutineSource(options: NativeRoutineCliPort & { input: CanonicalProviderRunInput; homePath: string;
  publish(event: CanonicalProviderRunEvent): void }) {
  const controller = new AbortController(), signal = AbortSignal.any([options.input.signal, controller.signal]);
  let socket: Duplex | undefined, ended = false, ready = false, selected = false, prompted = false;
  let liveSession: string | undefined, observed: HermesGatewayCatalog | undefined;
  let acknowledge: ((enabled: boolean) => void) | undefined, ackTimer: ReturnType<typeof setTimeout> | undefined;
  let registration: ReturnType<NativeRoutineCliPort["runtime"]["registerChat"]> | undefined;
  let invoker: ReturnType<typeof createFixedNativeRoutineCliInvoker> | undefined;
  const calls = new Map<string, AbortController>(); // <=8 active; delete on settlement, source-wide cancellation.
  const seen = new Set<string>(); // <=512 per finite source; never evict/replay; full source disables at cap.
  const cleanup = new Set<Promise<unknown>>(); // <=8 actions + one source revoke, drained on shutdown.
  const live = () => !ended && !signal.aborted;
  function observe(work: Promise<unknown>) {
    cleanup.add(work); void work.catch(error => console.warn("[hermes-routines] Cleanup unavailable", error instanceof Error ? error.name : "UnknownError")).finally(() => cleanup.delete(work));
  }
  function send(value: unknown) {
    if (!socket || socket.destroyed || !socket.writable || socket.writableLength > 196608) { end(); return false; }
    const bytes = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(bytes) > 196608) { end(); return false; }
    try { socket.write(bytes); return true; } catch (error) { console.warn("[hermes-routines] Write unavailable", error instanceof Error ? error.name : "UnknownError"); end(); return false; }
  }
  function end() {
    if (ended) return; ended = true; controller.abort(); clearTimeout(timer); options.input.signal.removeEventListener("abort", end);
    clearTimeout(ackTimer); acknowledge?.(false); acknowledge = undefined;
    for (const action of calls.values()) action.abort();
    // Retire the held descriptor itself. Native handler returns unknown under EOF; stdin/stdout remain independent.
    socket?.destroy();
    if (invoker) observe(invoker.close());
    if (registration) observe(registration.then(source => source.revoke()));
  }
  const timer = setTimeout(end, 30 * 60_000); timer.unref(); options.input.signal.addEventListener("abort", end, { once: true });
  type HermesGatewayCatalog = { session_id?: string; payload?: unknown };
  function inspect() {
    if (!liveSession || observed?.session_id !== liveSession) return;
    const parsed = Catalog.safeParse(observed.payload);
    selected = parsed.success && !parsed.data.lazy && Object.keys(parsed.data.tools).length <= 32
      && Object.values(parsed.data.tools).flat().filter(name => name === HERMES_ROUTINE_TOOL).length === 1;
    if (prompted && !selected) end();
  }
  async function call(frame: Extract<z.infer<typeof Frame>, { type: "call" }>) {
    const key = JSON.stringify(frame.context);
    if (!live() || !ready || !selected || !prompted || calls.size >= 8 || seen.has(frame.id) || seen.has(key) || seen.size >= 1024) {
      send({ type: "result", id: frame.id, context: frame.context, result: routineUnknownResult(frame.intent) }); return;
    }
    seen.add(frame.id); seen.add(key);
    const action = new AbortController(), actionSignal = AbortSignal.any([signal, action.signal]); calls.set(frame.id, action);
    const deadline = setTimeout(() => action.abort(), 120_000); deadline.unref();
    try {
      registration ??= options.runtime.registerChat({ input: options.input, provider: "hermes", signal, current: live, publish: options.publish });
      const source = await boundedOperation(() => registration!, 10_000, actionSignal);
      if (!live() || actionSignal.aborted) return;
      invoker ??= createFixedNativeRoutineCliInvoker({ binPath: options.binPath, endpoint: options.endpoint, cwd: options.input.executionRoot ?? options.homePath,
        homePath: options.homePath, authorize: source.authorize, issue: source.issue, cancel: source.cancel, timeoutMs: 120_000 });
      const result = RoutineCliEnvelopeSchema.parse(await invoker.invoke({ ...frame.intent, signal: actionSignal }));
      if (live() && !actionSignal.aborted) send({ type: "result", id: frame.id, context: frame.context, result: JSON.stringify(result) });
      else if (live()) send({ type: "result", id: frame.id, context: frame.context, result: routineUnknownResult(frame.intent) });
    } catch (error) {
      console.warn("[hermes-routines] Action unavailable", error instanceof Error ? error.name : "UnknownError");
      if (live()) send({ type: "result", id: frame.id, context: frame.context, result: routineUnknownResult(frame.intent) });
    } finally { clearTimeout(deadline); calls.delete(frame.id); }
  }
  return {
    attach(actual: Duplex) {
      if (socket || !live()) { actual.destroy(); return; } socket = actual;
      const decoder = new StringDecoder("utf8"); let buffer = "";
      actual.on("data", (chunk: Buffer) => {
        if (!live()) return; buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 196608) { end(); return; }
        let newline;
        while (live() && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let value: unknown; try { value = JSON.parse(line); } catch (error) { console.warn("[hermes-routines] Invalid frame", error instanceof Error ? error.name : "UnknownError"); end(); return; }
          const parsed = Frame.safeParse(value); if (!parsed.success) { end(); return; }
          const frame = parsed.data;
          if (frame.type === "ready") { if (ready) end(); else ready = true; }
          else if (frame.type === "enabled") { if (!acknowledge) end(); else { clearTimeout(ackTimer); acknowledge(true); acknowledge = undefined; } }
          else if (frame.type === "end") end();
          else if (frame.type === "cancel") calls.get(frame.id)?.abort();
          else observe(call(frame)); // Never block native frame consumption on owner/CLI waits.
        }
      });
      actual.once("end", end); actual.once("close", end); actual.once("error", end);
    },
    observe(event: { type: string; session_id?: string; payload?: unknown }) { if (event.type === "session.info") { observed = event; inspect(); } },
    setSession(id: string) { liveSession = id; inspect(); },
    async beforePrompt() {
      if (prompted || !ready || !selected || !live()) { end(); return false; }
      const enabled = await new Promise<boolean>(resolve => {
        acknowledge = resolve; ackTimer = setTimeout(end, 2000); ackTimer.unref();
        send({ type: "enable" });
      });
      prompted = enabled && live(); return prompted;
    },
    end,
    async close() { end(); try { await boundedOperation(() => Promise.allSettled([...cleanup]), 5000); } catch (error) { console.warn("[hermes-routines] Drain unconfirmed", error instanceof Error ? error.name : "UnknownError"); } },
  };
}
