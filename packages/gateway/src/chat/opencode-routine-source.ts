import { AsyncLocalStorage } from "node:async_hooks";
import type { Duplex } from "node:stream";
import { z } from "zod/v4";
import { RoutineCliEnvelopeSchema } from "@matrix-os/contracts/routine-cli";
import { boundedOperation } from "../bounded-operation.js";
import { createFixedNativeRoutineCliInvoker } from "../bots/routine-cli-invoker.js";
import { routineActionHash } from "../bots/routine-action-source-registry.js";
import type { RoutineCliVerifiedInvocation } from "../bots/routine-cli-source.js";
import { createCodingOutputBuffer } from "../coding-agents/coding-output-buffer.js";
import { RoutineArgvSchema, routineUnknownResult } from "../coding-agents/managed-launch-protocol.mjs";
import type { NativeRoutineCliPort } from "./claude-routine-execution.js";
import type { CanonicalProviderRunEvent, CanonicalProviderRunInput } from "./provider-adapter.js";

const ref = z.string().min(1).max(512);
const NativeContext = z.object({ sessionID: ref, messageID: ref, callID: ref, agent: ref, directory: ref, worktree: ref }).strict();
const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call"), id: z.uuid(), context: NativeContext, intent: RoutineArgvSchema }).strict(),
  z.object({ type: z.literal("cancel"), id: z.uuid() }).strict(),
]);
const execution = new AsyncLocalStorage<OpenCodeRoutineSource>();
/** Only the actual canonical execute closure installs this nonserializable context. */
export function nativeOpenCodeRoutineSource(): OpenCodeRoutineSource | undefined { return execution.getStore(); }

export function createOpenCodeRoutineSources(port: NativeRoutineCliPort | undefined, homePath: string) {
  if (port && (typeof port.runtime?.registerChat !== "function" || typeof port.binPath !== "string" || typeof port.endpoint !== "string")) {
    throw new Error("Routine source dependencies unavailable");
  }
  const sources = new Set<OpenCodeRoutineSource>(); // <=64, entries remain counted until registration/revocation drain.
  return {
    open(input: CanonicalProviderRunInput, publish: (event: CanonicalProviderRunEvent) => void) {
      if (!port || sources.size >= 64) return undefined;
      const source = createOpenCodeRoutineSource({ ...port, input, homePath, publish });
      sources.add(source);
      return { withContext: <T>(work: () => T) => execution.run(source, work), async close() {
        await source.close(); void source.drained().then(() => sources.delete(source));
      } };
    },
  };
}

/** A retained native child descriptor is correlation transport, never a principal or source selector. */
function createOpenCodeRoutineSource(options: NativeRoutineCliPort & { input: CanonicalProviderRunInput; homePath: string;
  publish(event: CanonicalProviderRunEvent): void }) {
  const controller = new AbortController(), signal = AbortSignal.any([options.input.signal, controller.signal]);
  let socket: Duplex | undefined, ended = false, sessionID: string | undefined, userMessageID: string | undefined, directory: string | undefined, worktree: string | undefined;
  let registration: ReturnType<NativeRoutineCliPort["runtime"]["registerChat"]> | undefined;
  const invokers = new Set<ReturnType<typeof createFixedNativeRoutineCliInvoker>>(); // <=8, removed after child cleanup.
  let sourceId: string | undefined;
  const messages = new Map<string, string>(); // <=512 assistant message -> actual agent; no eviction/reuse within source.
  const nativeCalls = new Map<string, { status: "running" | "terminal"; intent?: string }>(); // <=512, terminal tombstones never reopen.
  const invocations = new Map<string, { key: string; signal: AbortSignal; digest: string }>(); // <=512 accepted callbacks/source; retain for committed canonical claims.
  const seen = new Set<string>(); // <=1024 frame/call pairs; exhausted source ends rather than evicts identities.
  const actions = new Map<string, { controller: AbortController; key: string; wake?: () => void }>(); // <=8 including observation waits; remove after child cleanup.
  const cleanup = new Set<Promise<unknown>>(); // <=8 actions +8 child closes + one registration/revoke.
  const live = () => !ended && !signal.aborted;
  function observe(work: Promise<unknown>) {
    cleanup.add(work); void work.catch(error => console.warn("[opencode-routines] Cleanup unavailable", error instanceof Error ? error.name : "UnknownError")).finally(() => cleanup.delete(work));
  }
  function end() {
    if (ended) return; ended = true; controller.abort(); clearTimeout(timer); options.input.signal.removeEventListener("abort", end);
    for (const action of actions.values()) action.controller.abort(); socket?.destroy();
    for (const invoker of invokers) observe(invoker.close());
    if (registration) observe(registration.then(source => source.revoke()));
  }
  const timer = setTimeout(end, 30 * 60_000); timer.unref(); options.input.signal.addEventListener("abort", end, { once: true });
  function send(id: string, context: z.infer<typeof NativeContext>, result: string) {
    if (!live() || !socket || socket.destroyed) return;
    const frame = JSON.stringify({ type: "result", id, context, result }) + "\n";
    if (Buffer.byteLength(result) > 131072 || Buffer.byteLength(frame) > 196608 || socket.writableLength > 196608) { end(); return; }
    try { socket.write(frame); } catch (error) { console.warn("[opencode-routines] Write unavailable", error instanceof Error ? error.name : "UnknownError"); end(); }
  }
  function current(invocation?: RoutineCliVerifiedInvocation) {
    if (!live()) return false;
    if (!invocation) return true;
    const actual = invocations.get(invocation.invocationId);
    if (!actual || invocation.sourceId !== sourceId || actual.digest !== invocation.operationDigest) return false;
    // Only validateAcceptedWithin reconstructs accepted:true from the consumed capability/real receipt.
    // Normal tool completion cannot undo that commit; parent Run/policy still fence the later claim.
    return invocation.accepted === true || nativeCalls.get(actual.key)?.status === "running" && !actual.signal.aborted;
  }
  function notify() { for (const action of actions.values()) action.wake?.(); }
  async function call(frame: Extract<z.infer<typeof Frame>, { type: "call" }>) {
    const native = frame.context, key = JSON.stringify([native.sessionID, native.messageID, native.callID]);
    if (!live() || !userMessageID || native.sessionID !== sessionID || native.directory !== directory || native.worktree !== worktree
      || native.agent !== "build" || seen.has(frame.id) || seen.has(key)) {
      send(frame.id, native, routineUnknownResult(frame.intent)); return;
    }
    if (seen.size >= 1024) { end(); return; }
    seen.add(frame.id); seen.add(key); // Reserve before waiting: late/duplicate callbacks cannot replay admission.
    if (actions.size >= 8) { send(frame.id, native, routineUnknownResult(frame.intent)); return; }
    const action = { controller: new AbortController(), key, wake: undefined as (() => void) | undefined };
    const actionSignal = AbortSignal.any([signal, action.controller.signal]); actions.set(frame.id, action);
    const deadline = setTimeout(() => action.controller.abort(), 120_000); deadline.unref();
    let invoker: ReturnType<typeof createFixedNativeRoutineCliInvoker> | undefined;
    try {
      // SSE and the retained FD are independent. Wait for both exact observations, with no source authority meanwhile.
      const matched = await new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return; settled = true; clearTimeout(wait); action.wake = undefined;
          actionSignal.removeEventListener("abort", abort); resolve(value);
        };
        const abort = () => finish(false);
        const wait = setTimeout(() => { action.controller.abort(); finish(false); }, 2000); wait.unref();
        action.wake = () => {
          const observed = nativeCalls.get(key), agent = messages.get(native.messageID);
          if (!live() || actionSignal.aborted || observed?.status === "terminal"
            || observed?.intent !== undefined && observed.intent !== JSON.stringify(frame.intent)
            || agent !== undefined && agent !== native.agent) finish(false);
          else if (observed?.status === "running" && agent === native.agent) finish(true);
        };
        actionSignal.addEventListener("abort", abort, { once: true }); action.wake();
      });
      if (!matched || actionSignal.aborted || !live()) { send(frame.id, native, routineUnknownResult(frame.intent)); return; }
      registration ??= options.runtime.registerChat({ input: options.input, provider: "opencode", signal, current, publish: options.publish });
      const registered = await boundedOperation(() => registration!, 10_000, actionSignal);
      if (!live() || actionSignal.aborted) { send(frame.id, native, routineUnknownResult(frame.intent)); return; }
      sourceId = registered.reference.sourceId;
      invoker = createFixedNativeRoutineCliInvoker({ binPath: options.binPath, endpoint: options.endpoint, cwd: directory!, homePath: options.homePath,
        authorize(call) {
          invocations.set(call.invocationId, { key, signal: actionSignal, digest: routineActionHash(call.operation) });
          return current({ sourceId: sourceId!, invocationId: call.invocationId, operationDigest: routineActionHash(call.operation) })
            ? registered.authorize(call) : Promise.resolve(false);
        }, issue: registered.issue, cancel: registered.cancel, timeoutMs: 120_000 });
      invokers.add(invoker);
      const result = RoutineCliEnvelopeSchema.parse(await invoker.invoke({ ...frame.intent, signal: actionSignal }));
      send(frame.id, native, actionSignal.aborted ? routineUnknownResult(frame.intent) : JSON.stringify(result));
    } catch (error) {
      console.warn("[opencode-routines] Action unavailable", error instanceof Error ? error.name : "UnknownError");
      send(frame.id, native, routineUnknownResult(frame.intent));
    } finally {
      clearTimeout(deadline); action.wake = undefined;
      if (invoker) { await invoker.close(); invokers.delete(invoker); }
      actions.delete(frame.id);
    }
  }
  const source = {
    current: live,
    attach(actual: Duplex) {
      if (socket || !live()) { actual.destroy(); return; } socket = actual;
      const frames = createCodingOutputBuffer(196608);
      actual.on("data", (chunk: Buffer) => {
        if (!live()) return;
        try { frames.push(chunk, line => {
          const parsed = Frame.safeParse(JSON.parse(line)); if (!parsed.success) { end(); return false; }
          if (parsed.data.type === "cancel") actions.get(parsed.data.id)?.controller.abort(); else observe(call(parsed.data));
          return live();
        }); } catch (error) { console.warn("[opencode-routines] Invalid frame", error instanceof Error ? error.name : "UnknownError"); end(); }
      });
      actual.once("end", end); actual.once("close", end); actual.once("error", end);
    },
    beforePrompt(session: string, message: string, cwd: string, root: string) {
      if (!live() || userMessageID) { end(); return false; }
      sessionID = session; userMessageID = message; directory = cwd; worktree = root; return true;
    },
    observeMessage(info: Record<string, unknown>) {
      if (!live() || info.sessionID !== sessionID || info.parentID !== userMessageID || info.role !== "assistant"
        || !ref.safeParse(info.id).success || !ref.safeParse(info.agent).success) return;
      if (messages.size >= 512 && !messages.has(info.id as string)) { end(); return; }
      const id = info.id as string, agent = info.agent as string;
      if (agent !== "build") { end(); return; }
      if (messages.has(id) && messages.get(id) !== agent) { end(); return; } messages.set(id, agent); notify();
    },
    observePart(part: Record<string, unknown>) {
      if (!live() || part.sessionID !== sessionID || !ref.safeParse(part.messageID).success
        || part.type !== "tool" || part.tool !== "matrix_routines" || !ref.safeParse(part.callID).success) return;
      const state = part.state as { status?: unknown; input?: { intent?: unknown } } | undefined;
      if (!["running", "completed", "error"].includes(String(state?.status))) return;
      const key = JSON.stringify([sessionID, part.messageID, part.callID]);
      if (nativeCalls.size >= 512 && !nativeCalls.has(key)) { end(); return; }
      const previous = nativeCalls.get(key);
      if (previous?.status === "terminal") return; // Even a later running event cannot resurrect the native call.
      const intent = RoutineArgvSchema.safeParse(state?.input?.intent);
      if (state?.status !== "running" || !intent.success || previous?.intent !== undefined && previous.intent !== JSON.stringify(intent.data)) {
        nativeCalls.set(key, { status: "terminal" });
        for (const action of actions.values()) if (action.key === key) action.controller.abort();
      } else nativeCalls.set(key, { status: "running", intent: JSON.stringify(intent.data) });
      notify();
    },
    end,
    drained: () => Promise.allSettled([...cleanup]),
    async close() { end(); try { await boundedOperation(() => source.drained(), 5000); } catch (error) {
      console.warn("[opencode-routines] Drain unconfirmed", error instanceof Error ? error.name : "UnknownError");
    } },
  };
  if (options.input.signal.aborted) end();
  return source;
}
export type OpenCodeRoutineSource = ReturnType<typeof createOpenCodeRoutineSource>;
