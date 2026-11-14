import { boundedOperation } from "../bounded-operation.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createFixedNativeRoutineCliInvoker } from "../bots/routine-cli-invoker.js";
import { RoutineCliEnvelopeSchema } from "@matrix-os/contracts/routine-cli";
import type { BackgroundPrivateControl, ManagedLaunchChannel } from "../background-launch-channel.js";
import type { ManagedHostFrame, ManagedShimFrame, ManagedTuple } from "../coding-agents/managed-launch-protocol.mjs";
import { RoutineArgvSchema, routineUnknownResult } from "../coding-agents/managed-launch-protocol.mjs";
import type { NativeRoutineCliPort } from "./claude-routine-execution.js";
import type { CanonicalProviderRunInput, CanonicalProviderRunEvent } from "./provider-adapter.js";
type Turn = NonNullable<Extract<ManagedHostFrame, { type: "host.turn" }>["turn"]>;
interface Admission {
  ownerId: string; admissionId: string;
  prepare(sessionId: string): void;
  launch(sessionId: string): BackgroundPrivateControl;
  queued(sessionId: string, turn: Turn, clientRequestId: string): Promise<boolean>;
}
export class CodexRoutineTurnDeliveryUnconfirmedError extends Error {
  readonly delivery = "unknown";
  constructor() { super("Routine turn delivery unconfirmed"); this.name = "CodexRoutineTurnDeliveryUnconfirmedError"; }
}
const context = new AsyncLocalStorage<Admission>();
/** This host-only object is never a request DTO, serialized descriptor or generic control credential. */
export function nativeCodexRoutineAdmission(ownerId: string): Admission | undefined {
  const source = context.getStore(); if (source && source.ownerId !== ownerId) throw new Error("Routine source unavailable"); return source;
}
export function createCodexRoutineSources(port: NativeRoutineCliPort | undefined, homePath: string) {
  type Transport = { ownerId: string; channel: ManagedLaunchChannel; sources: Set<{ end(): void }> };
  const transports = new Map<string, Transport>(); // max64, actual pipe-close eviction; never reconstructed from IDs/liveness.
  const admissions = new Map<string, { receive(frame: ManagedShimFrame, channel: ManagedLaunchChannel): void; end(): void }>(); // max64; TTL, source end, parent cancellation and close.
  return {
    open(input: CanonicalProviderRunInput, publish: (event: CanonicalProviderRunEvent) => void) {
      if (!port || admissions.size >= 64) return undefined;
      const admissionId = randomUUID(), controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal]);
      let transport: Transport | undefined;
      let ended = false, session: string | undefined, channel: ManagedLaunchChannel | undefined, binding: Readonly<ManagedTuple> | undefined;
      let registration: ReturnType<NativeRoutineCliPort["runtime"]["registerChat"]> | undefined;
      let invoker: ReturnType<typeof createFixedNativeRoutineCliInvoker> | undefined;
      let accepted: (() => void) | undefined, rejected: (() => void) | undefined;
      const actions = new Map<string, AbortController>(); // max8 active; delete on settlement/abort. Shim owns completed-call tombstones.
      const cleanup = new Set<Promise<unknown>>(); // at most8 child actions + one source revoke.
      const live = () => !ended && !signal.aborted;
      function observe(promise: Promise<unknown>) { cleanup.add(promise); void promise.catch(error => console.warn("[codex-routines] Cleanup unavailable", error instanceof Error ? error.name : "UnknownError")).finally(() => cleanup.delete(promise)); }
      function end() {
        if (ended) return; ended = true; controller.abort(); clearTimeout(timer); input.signal.removeEventListener("abort", end);
        transport?.sources.delete(entry); rejected?.(); rejected = undefined; accepted = undefined;
        channel?.send({ type: "host.cancel", admissionId });
        if (invoker) observe(invoker.close());
        if (registration) observe(registration.then(source => source.revoke()));
        // Keep draining entries counted against the cap; a lost DB setup cannot create unbounded late registrations.
        void Promise.allSettled([...cleanup]).then(() => admissions.delete(admissionId));
      }
      const timer = setTimeout(end, 30 * 60_000); timer.unref(); input.signal.addEventListener("abort", end, { once: true });
      async function call(frame: Extract<ManagedShimFrame, { type: "shim.call" }>) {
        if (!live() || !binding || actions.size >= 8 || actions.has(frame.actionId) || !["admissionId", "nativeGeneration", "threadId", "turnId"].every(key => frame[key as keyof ManagedTuple] === binding![key as keyof ManagedTuple])) return;
        const intent = RoutineArgvSchema.safeParse(frame.intent); if (!intent.success) return;
        const action = new AbortController(), actionSignal = AbortSignal.any([signal, action.signal]);
        actions.set(frame.actionId, action);
        try {
          registration ??= port!.runtime.registerChat({ input, provider: "codex", signal, current: live, publish });
          const source = await boundedOperation(() => registration!, 10_000, actionSignal);
          if (!live() || actionSignal.aborted) return;
          invoker ??= createFixedNativeRoutineCliInvoker({ binPath: port!.binPath, endpoint: port!.endpoint, cwd: homePath, homePath,
            authorize: source.authorize, issue: source.issue, cancel: source.cancel, timeoutMs: 120_000 });
          const result = RoutineCliEnvelopeSchema.parse(await invoker.invoke({ ...intent.data, signal: actionSignal }));
          if (live() && binding && frame.turnId === binding.turnId && frame.nativeGeneration === binding.nativeGeneration) channel?.send({ type: "host.result", admissionId, actionId: frame.actionId, result: JSON.stringify(result) });
        } catch (error) {
          console.warn("[codex-routines] Action unavailable", error instanceof Error ? error.name : "UnknownError");
          if (live()) channel?.send({ type: "host.result", admissionId, actionId: frame.actionId, result: routineUnknownResult(intent.data) });
        } finally { actions.delete(frame.actionId); }
      }
      const entry = { end, receive(frame: ManagedShimFrame, actual: ManagedLaunchChannel) {
        if (channel !== actual || !live() || !("admissionId" in frame) || frame.admissionId !== admissionId) return;
        if (frame.type === "shim.cancel") { actions.get(frame.actionId)?.abort(); return; }
        if (frame.type === "shim.end") { end(); return; }
        if (frame.type === "shim.accepted") { accepted?.(); accepted = undefined; rejected = undefined; return; }
        if (frame.type === "shim.bound") {
          if (binding) { end(); return; }
          binding = Object.freeze({ admissionId, nativeGeneration: frame.nativeGeneration, threadId: frame.threadId, turnId: frame.turnId }); return;
        }
        if (frame.type === "shim.call") observe(call(frame));
      } };
      admissions.set(admissionId, entry);
      const admission: Admission = {
        ownerId: input.owner.ownerId, admissionId,
        prepare(value) { if (!live() || session && session !== value) throw new Error("Routine source unavailable"); session = value; },
        launch(value) {
          if (!live() || session !== value) throw new Error("Routine source unavailable");
          return { onReady(actual) {
            if (!live() || transports.has(value) || transports.size >= 64) { actual.close(); return; }
            channel = actual; transport = { ownerId: input.owner.ownerId, channel: actual, sources: new Set([entry]) }; const held = transport;
            transports.set(value, held);
            actual.subscribe(frame => { if ("admissionId" in frame) admissions.get(frame.admissionId)?.receive(frame, actual); }, () => {
              if (transports.get(value) === held) transports.delete(value);
              for (const source of [...held.sources]) source.end(); held.sources.clear();
            });
            if (!actual.send({ type: "host.turn", admissionId, first: true })) end();
          } };
        },
        async queued(value, turn, clientRequestId) {
          if (!live()) return false;
          const held = transports.get(value);
          if (!held || held.ownerId !== input.owner.ownerId) return false;
          session = value; transport = held; channel = held.channel; held.sources.add(entry);
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await new Promise<void>((resolve, reject) => {
              const failed = () => reject(new CodexRoutineTurnDeliveryUnconfirmedError());
              accepted = resolve; rejected = failed;
              timeout = setTimeout(failed, 10_000); timeout.unref();
              const finish = accepted, fail = rejected;
              accepted = () => { clearTimeout(timeout); finish(); }; rejected = () => { clearTimeout(timeout); fail(); };
              if (!channel!.send({ type: "host.turn", admissionId, first: false, turn, clientRequestId })) rejected();
            });
            return true;
          } catch (error) { end(); throw error; } finally { clearTimeout(timeout); }
        },
      };
      if (input.signal.aborted) end();
      return {
        withContext: <T>(work: () => T) => context.run(admission, work),
        async close() { end(); try { await boundedOperation(() => Promise.allSettled([...cleanup]), 5_000); } catch (error) { console.warn("[codex-routines] Source drain unconfirmed", error instanceof Error ? error.name : "UnknownError"); } },
      };
    },
  };
}
