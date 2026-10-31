import { randomUUID } from "node:crypto";
import type { RoutineCliOperation, RoutineCliEnvelope } from "@matrix-os/contracts/routine-cli";
import { boundedOperation } from "../bounded-operation.js";
import type { TerminalLaunchChannel } from "../background-launch-channel.js";
import { TerminalShimFrameSchema, type TerminalShimFrame, type TerminalBoundFrame } from "../coding-agents/terminal-launch-protocol.mjs";
import type { LinuxProcessIdentity } from "./process-identity.js";
import { terminalUnavailable } from "./host-channel.js";
export interface TerminalSourcePort {
  invoke(operation: RoutineCliOperation, writer: LinuxProcessIdentity, signal: AbortSignal): Promise<RoutineCliEnvelope>;
  end(): void;
  close(): Promise<void>;
}
export interface RetainedTerminalStartup {
  readonly identity: Readonly<TerminalBoundFrame>; readonly heldGeneration: string; readonly signal: AbortSignal;
  current(): boolean;
  /** Retire private proof/channel only; never stop native workload or I/O. */
  retire(): void;
  /** Slow manager preflight before source admission/issuance, never inside a DB transaction.
   * Consume/claim compare pinned supervisor/host/root process identities and the current private fence locally. */
  verifyCurrent(): Promise<boolean>;
}
/** Host-only seam. Later authenticated route admission retains its principal in
 * onBound's closure; no descriptor, restored PID or ordinary UDS input can supply it. */
export function createRetainedTerminalBinding(options: {
  channel: TerminalLaunchChannel; verify(bound: TerminalBoundFrame): Promise<boolean>;
  onBound?(startup: RetainedTerminalStartup): Promise<TerminalSourcePort | undefined>;
}) {
  const { channel } = options, admissionId = randomUUID(), heldGeneration = channel.generation, controller = new AbortController();
  let identity: TerminalBoundFrame | undefined, source: TerminalSourcePort | undefined, createdSource: TerminalSourcePort | undefined, endedSource: TerminalSourcePort | undefined, binding = false, checking = false;
  let settle!: (ready: boolean) => void, detach = () => {};
  const ready = new Promise<boolean>(resolve => { settle = resolve; });
  const pending = new Map<string, { controller: AbortController; done: Promise<void> }>(); // <=8 including cancelled work until actual settlement.
  const seen = new Set<string>(); // <=256 per source, cleared on fence; same lifetime as source invocation tombstones.
  const drains = new Set<Promise<unknown>>(); // <=10:8 actions+one late factory+one source cleanup; bounded close wait.
  function observe(work: Promise<unknown>) {
    drains.add(work); void work.catch(error => console.warn("[terminal-host] Source cleanup unavailable", error instanceof Error ? error.name : "UnknownError")).finally(() => drains.delete(work));
  }
  function endSource(port: TerminalSourcePort) {
    if (endedSource === port) return; endedSource = port;
    try { port.end(); } catch (error) { console.warn("[terminal-host] Source fence unavailable", error instanceof Error ? error.name : "UnknownError"); }
    observe(Promise.resolve().then(() => port.close()));
  }
  function fence() {
    if (controller.signal.aborted) return;
    controller.abort(); clearTimeout(deadline); clearInterval(monitor); detach(); settle(false);
    for (const entry of pending.values()) entry.controller.abort();
    seen.clear(); if (source ?? createdSource) endSource((source ?? createdSource)!);
    channel.close(); // Private FD closure only. No service/native workload stop is present here.
  }
  const current = () => !controller.signal.aborted && !!identity && channel.generation === heldGeneration;
  async function verifyCurrent() {
    if (!current()) return false;
    try {
      if (await boundedOperation(() => options.verify(identity!), 10000, controller.signal) && current()) return true;
    } catch (error) { console.warn("[terminal-host] Held proof unavailable", error instanceof Error ? error.name : "UnknownError"); }
    fence(); return false;
  }
  async function bind(frame: TerminalBoundFrame) {
    try {
      if (!await boundedOperation(() => options.verify(frame), 10000, controller.signal) || controller.signal.aborted) { fence(); return; }
      identity = Object.freeze({ ...frame, host: Object.freeze({ ...frame.host }), root: Object.freeze({ ...frame.root }), supervisor: Object.freeze({ ...frame.supervisor }) });
      // Keep the factory's actual settlement observed after an early EOF, so a late registration is revoked.
      const creating = Promise.resolve().then(() => options.onBound?.({ identity: identity!, heldGeneration, signal: controller.signal, current, verifyCurrent, retire: fence }));
      observe(creating.then(port => { createdSource = port; if (controller.signal.aborted && port) endSource(port); }));
      const port = await boundedOperation(() => creating, 10000, controller.signal);
      if (controller.signal.aborted) return;
      if (!port) { fence(); return; }
      source = port; clearTimeout(deadline); settle(true);
    } catch (error) { console.warn("[terminal-host] Source binding unavailable", error instanceof Error ? error.name : "UnknownError"); fence(); }
  }
  async function dispatch(frame: Extract<TerminalShimFrame, { type: "terminal.call" }>, signal: AbortSignal) {
    let result = terminalUnavailable(frame.operation);
    try {
      if (!identity || !source) { fence(); return; }
      const valid = await boundedOperation(() => options.verify(identity!), 10000, signal);
      if (signal.aborted) return;
      if (!valid || !current()) { fence(); return; }
      result = await source.invoke(frame.operation, frame.writer, signal);
    } catch (error) { console.warn("[terminal-host] Routine action unavailable", error instanceof Error ? error.name : "UnknownError"); }
    if (!signal.aborted && current()) channel.send({ type: "host.terminal.result", admissionId, actionId: frame.actionId, result });
  }
  function receive(raw: TerminalShimFrame) {
    if (controller.signal.aborted) return;
    const parsed = TerminalShimFrameSchema.safeParse(raw);
    if (!parsed.success) { fence(); return; }
    const frame = parsed.data;
    if (!("admissionId" in frame) || frame.admissionId !== admissionId) { fence(); return; }
    if (frame.type === "terminal.end") { fence(); return; }
    if (frame.type === "terminal.bound" && !binding) { binding = true; void bind(frame); return; }
    if (!identity || !source || frame.type === "terminal.bound") { fence(); return; }
    if (frame.type === "terminal.cancel") { pending.get(frame.actionId)?.controller.abort(); return; }
    if (seen.has(frame.actionId) || seen.size >= 256 || pending.size >= 8) { fence(); return; }
    seen.add(frame.actionId); const action = new AbortController();
    const signal = AbortSignal.any([controller.signal, action.signal, AbortSignal.timeout(120000)]);
    const done = dispatch(frame, signal).finally(() => pending.delete(frame.actionId));
    pending.set(frame.actionId, { controller: action, done }); observe(done);
  }
  const deadline = setTimeout(fence, 10000); deadline.unref();
  const monitor = setInterval(() => {
    if (!identity || controller.signal.aborted || checking) return;
    checking = true;
    void boundedOperation(() => options.verify(identity!), 10000, controller.signal).then(valid => { if (!valid) fence(); })
      .catch(error => { console.warn("[terminal-host] Current binding unavailable", error instanceof Error ? error.name : "UnknownError"); fence(); }).finally(() => { checking = false; });
  }, 1000); monitor.unref();
  detach = channel.subscribe(receive, fence);
  if (!channel.send({ type: "host.terminal.admit", admissionId })) fence();
  return { ready, signal: controller.signal, current,
    async close() { fence(); try { await boundedOperation(() => Promise.allSettled([...drains]), 5000); }
      catch (error) { console.warn("[terminal-host] Source drain unconfirmed", error instanceof Error ? error.name : "UnknownError"); } },
  };
}
