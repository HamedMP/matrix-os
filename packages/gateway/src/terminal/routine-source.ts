import { randomUUID } from "node:crypto";
import { RoutineCliOperationSchema, RoutineCliEnvelopeSchema, type RoutineCliOperation, type RoutineCliEnvelope } from "@matrix-os/contracts/routine-cli";
import { boundedOperation } from "../bounded-operation.js";
import { createFixedNativeRoutineCliInvoker } from "../bots/routine-cli-invoker.js";
import { routineActionHash, type RoutineSourcePolicy } from "../bots/routine-action-source-registry.js";
import type { RoutineCliRuntime } from "../bots/routine-cli-runtime.js";
import { RoutineCliSourceContextSchema, type RoutineCliSourceContext } from "../bots/routine-cli-source-context.js";
import type { RoutineCliVerifiedInvocation } from "../bots/routine-cli-source.js";
import type { RequestPrincipal } from "../request-principal.js";
import { readLinuxProcess, sameProcess, verifyTerminalDescendant, type LinuxProcessIdentity } from "./process-identity.js";
export interface TerminalRoutineAdmission {
  principal: RequestPrincipal; harness: RoutineCliSourceContext["harness"]; sessionId: string; incarnationId: string; launchId: string; generation: string;
  /** Taken ONLY from the actual held host spawn/private bridge, never public restore records. */
  host: LinuxProcessIdentity; root: LinuxProcessIdentity; policy: RoutineSourcePolicy;
}
function command(operation: RoutineCliOperation) {
  switch (operation.operation) {
    case "list": return { args: ["list"] };
    case "show": return { args: ["show", operation.routineId] };
    case "request": return { args: ["request", operation.requestId] };
    case "propose": return { args: ["propose", "--input", "-", "--request-id", operation.requestId], stdin: JSON.stringify(operation.proposal) };
    default: return { args: [operation.operation, operation.routineId, "--revision", String(operation.baseRevision), "--request-id", operation.requestId] };
  }
}
function unavailable(operation: RoutineCliOperation): RoutineCliEnvelope {
  return ["propose", "pause", "resume", "archive"].includes(operation.operation) && "requestId" in operation
    ? { v: 1, ok: true, data: { kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true } }
    : { v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } };
}
/** Shared Terminal source. Actual native writer is attested by the held host before
 * this entry; this repeats root/start/ancestry checks around owner waits and consume.
 * Never creates a Chat/run/Bot binding or infers policy from CLI --yolo flags. */
export function createTerminalRoutineSource(options: {
  runtime: Pick<RoutineCliRuntime, "register">; computerId: string; binPath: string; endpoint: string; homePath: string;
  admission: TerminalRoutineAdmission; signal: AbortSignal; current(): boolean; readProcess?: typeof readLinuxProcess;
}) {
  const admission = structuredClone(options.admission), read = options.readProcess ?? readLinuxProcess;
  if (admission.root.ppid !== admission.host.pid || admission.root.uid !== admission.host.uid || admission.root.gid !== admission.host.gid
    || typeof options.runtime?.register !== "function" || typeof options.current !== "function") throw new Error("Terminal source unavailable");
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, options.signal]);
  const now = new Date(), source = RoutineCliSourceContextSchema.parse({ ownerId: admission.principal.userId, computerId: options.computerId,
    harness: admission.harness, identity: { kind: "terminal_launch", sessionId: admission.sessionId, incarnationId: admission.incarnationId, launchId: admission.launchId },
    generation: `${admission.generation}:${randomUUID()}`, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60000).toISOString(), actions: ["read", "propose", "control"] });
  let registration: ReturnType<RoutineCliRuntime["register"]> | undefined, sourceId: string | undefined, checking = false, activeCalls = 0;
  const invocations = new Map<string, { digest: string; writer: LinuxProcessIdentity; signal: AbortSignal }>(); // <=256 retained accepted-claim tombstones, TTL/source close clears.
  const invokers = new Set<ReturnType<typeof createFixedNativeRoutineCliInvoker>>(); // <=8, finally and shutdown drain.
  const cleanups = new Set<Promise<unknown>>(); // <=8 cancellation/drains + one register/revoke.
  const live = () => !signal.aborted && options.current();
  function observe(work: Promise<unknown>) {
    cleanups.add(work); void work.catch(error => console.warn("[terminal-routines] Cleanup unavailable", error instanceof Error ? error.name : "UnknownError")).finally(() => cleanups.delete(work));
  }
  async function actualRoot() {
    if (!live()) return false;
    try {
      const host = await read(admission.host.pid), root = await read(admission.root.pid);
      return live() && sameProcess(admission.host, host) && sameProcess(admission.root, root) && root.ppid === host.pid;
    } catch (error) { console.warn("[terminal-routines] Root unavailable", error instanceof Error ? error.name : "UnknownError"); return false; }
  }
  async function current(invocation?: RoutineCliVerifiedInvocation) {
    if (!await actualRoot()) return false;
    if (!invocation) return true;
    const call = invocations.get(invocation.invocationId);
    if (!call || invocation.sourceId !== sourceId || call.digest !== invocation.operationDigest) return false;
    // Only the real consumed-capability/receipt validator supplies accepted:true.
    if (invocation.accepted === true) return true;
    if (call.signal.aborted) return false;
    const writer = await verifyTerminalDescendant(admission.root, call.writer, read);
    return !!writer && sameProcess(call.writer, writer) && live() && !call.signal.aborted;
  }
  function end() {
    if (controller.signal.aborted) return;
    controller.abort(); invocations.clear(); clearInterval(monitor); clearTimeout(expiry); options.signal.removeEventListener("abort", end);
    if (registration) observe(registration.then(port => port.revoke()));
    for (const invoker of invokers) observe(invoker.close());
  }
  const expiry = setTimeout(end, 30 * 60000); expiry.unref();
  const monitor = setInterval(() => { if (checking || signal.aborted) return; checking = true; void actualRoot().then(valid => { if (!valid) end(); }).finally(() => checking = false); }, 250); monitor.unref();
  options.signal.addEventListener("abort", end, { once: true }); if (options.signal.aborted) end();
  return {
    end,
    async invoke(raw: RoutineCliOperation, writer: LinuxProcessIdentity, callSignal: AbortSignal): Promise<RoutineCliEnvelope> {
      const operation = RoutineCliOperationSchema.parse(raw);
      if (activeCalls >= 8) return unavailable(operation);
      activeCalls++;
      try {
      const actionSignal = AbortSignal.any([signal, callSignal, AbortSignal.timeout(120000)]);
      if (!live() || actionSignal.aborted || invokers.size >= 8 || invocations.size >= 256 || !await actualRoot()) return unavailable(operation);
      const observed = await verifyTerminalDescendant(admission.root, writer, read);
      if (!observed || !sameProcess(writer, observed)) return unavailable(operation);
      let invoker: ReturnType<typeof createFixedNativeRoutineCliInvoker> | undefined, invocationId: string | undefined;
      const cancel = () => { if (registration && invocationId) observe(registration.then(port => port.cancel({ invocationId: invocationId!, reason: "aborted" }))); };
      actionSignal.addEventListener("abort", cancel, { once: true });
      try {
        registration ??= options.runtime.register({ source, signal, readPolicy: () => ({ ...admission.policy, live: live() && admission.policy.live }),
          validateWithin: async (_source, _trx, _action, invocation) => current(invocation) });
        const port = await boundedOperation(() => registration!, 10000, actionSignal); sourceId = port.reference.sourceId;
        if (!live() || actionSignal.aborted) return unavailable(operation);
        invoker = createFixedNativeRoutineCliInvoker({ binPath: options.binPath, endpoint: options.endpoint, cwd: options.homePath, homePath: options.homePath, timeoutMs: 120000,
          authorize(input) {
            // Recheck synchronously at insertion: concurrent process/registration awaits must not overbook.
            if (!live() || actionSignal.aborted || invocations.size >= 256) return Promise.resolve(false);
            invocationId = input.invocationId; invocations.set(invocationId, { digest: routineActionHash(input.operation), writer: observed, signal: actionSignal });
            return port.authorize(input);
          }, issue: port.issue, cancel: port.cancel });
        invokers.add(invoker);
        return RoutineCliEnvelopeSchema.parse(await invoker.invoke({ ...command(operation), expectedOperation: operation, signal: actionSignal }));
      } catch (error) { console.warn("[terminal-routines] Invocation unavailable", error instanceof Error ? error.name : "UnknownError"); return unavailable(operation); }
      finally { actionSignal.removeEventListener("abort", cancel); if (invoker) { await invoker.close(); invokers.delete(invoker); } }
      } finally { activeCalls--; }
    },
    async close() { end(); try { await boundedOperation(() => Promise.allSettled([...cleanups]), 5000); }
      catch (error) { console.warn("[terminal-routines] Drain unconfirmed", error instanceof Error ? error.name : "UnknownError"); } },
  };
}
