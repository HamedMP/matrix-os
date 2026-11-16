import { randomUUID } from "node:crypto";
import { RoutineCliOperationSchema, routineCliResultMatchesOperation, type RoutineCliOperation, type RoutineCliEnvelope } from "@matrix-os/contracts/routine-cli";
import { boundedOperation } from "../bounded-operation.js";
import { parseManagedFrame } from "../coding-agents/managed-launch-protocol.mjs";
import { TerminalHostFrameSchema, TerminalShimFrameSchema, TerminalProcessSchema, type TerminalShimFrame, type TerminalBoundFrame } from "../coding-agents/terminal-launch-protocol.mjs";
import type { LinuxProcessIdentity } from "./process-identity.js";
export interface TerminalHostIpc {
  connected?: boolean;
  send(frame: unknown, callback: (error?: Error | null) => void): unknown;
  on(event: "message" | "disconnect", listener: (...args: unknown[]) => void): unknown;
  off(event: "message" | "disconnect", listener: (...args: unknown[]) => void): unknown;
}
export function terminalUnavailable(operation: RoutineCliOperation): RoutineCliEnvelope {
  return ["propose", "pause", "resume", "archive"].includes(operation.operation) && "requestId" in operation
    ? { v: 1, ok: true, data: { kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true } }
    : { v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } };
}
/** Lives inside the separately supervised host. Its ONLY authority transport is the
 * inherited parent IPC. It has no stop/kill/attach operation and cannot end native I/O. */
export function createTerminalHostChannel(options: {
  transport: TerminalHostIpc; digest: string; generation: string; signal: AbortSignal;
  identity(): Promise<Pick<TerminalBoundFrame, "host" | "root" | "supervisor" | "invocationId">>;
}) {
  const shim = randomUUID(), controller = new AbortController(), transport = options.transport;
  let ready = false, admissionId: string | undefined, bound = false, sending = 0;
  type Pending = { operation: RoutineCliOperation; finish(result?: RoutineCliEnvelope): void };
  const pending = new Map<string, Pending>(); // <=8, per-action deadline/cancel + source shutdown drains.
  const cancelled = new Map<string, number>(); // <=256,120s TTL + shutdown; only late cancelled replies may be ignored.
  function sweep() { const now = Date.now(); for (const [id, expiry] of cancelled) if (expiry <= now) cancelled.delete(id); }
  function send(frame: TerminalShimFrame) {
    if (controller.signal.aborted || !transport.connected || sending >= 16 || !parseManagedFrame(TerminalShimFrameSchema, frame)) { close(); return false; }
    sending++;
    try { transport.send(frame, error => { sending--; if (error) close(); }); return true; }
    catch (error) { sending--; console.warn("[terminal-host] Private send unavailable", error instanceof Error ? error.name : "UnknownError"); close(); return false; }
  }
  function close() {
    if (controller.signal.aborted) return;
    controller.abort(); clearTimeout(deadline); clearInterval(retention);
    if (admissionId && transport.connected && sending < 16) {
      try { transport.send({ type: "terminal.end", admissionId }, error => { if (error) console.warn("[terminal-host] End notification unavailable", error.name); }); }
      catch (error) { console.warn("[terminal-host] End notification unavailable", error instanceof Error ? error.name : "UnknownError"); }
    }
    transport.off("message", receive); transport.off("disconnect", close); options.signal.removeEventListener("abort", close);
    for (const item of pending.values()) item.finish();
    pending.clear(); cancelled.clear();
  }
  async function bind(id: string) {
    try {
      const identity = await boundedOperation(options.identity, 2000, controller.signal);
      if (controller.signal.aborted) return;
      const frame = TerminalShimFrameSchema.parse({ type: "terminal.bound", admissionId: id, generation: options.generation, ...identity });
      bound = send(frame);
    } catch (error) { console.warn("[terminal-host] Binding unavailable", error instanceof Error ? error.name : "UnknownError"); close(); }
  }
  function receive(raw: unknown, handle?: unknown) {
    const frame = parseManagedFrame(TerminalHostFrameSchema, raw);
    if (controller.signal.aborted) return;
    if (handle || !frame || frame.type === "host.disconnect") { close(); return; }
    if (!ready) {
      if (frame.type !== "host.ready" || frame.shim !== shim || frame.digest !== options.digest) { close(); return; }
      ready = true; return;
    }
    if (frame.type === "host.terminal.admit" && !admissionId) {
      admissionId = frame.admissionId; clearTimeout(deadline); void bind(admissionId); return;
    }
    if (!bound || !admissionId || frame.type === "host.ready" || frame.admissionId !== admissionId || frame.type === "host.terminal.admit") { close(); return; }
    if (frame.type === "host.terminal.cancel") { close(); return; }
    sweep();
    const item = pending.get(frame.actionId);
    if (!item) {
      if (cancelled.has(frame.actionId)) return;
      close(); return;
    }
    if ("ok" in frame.result && !routineCliResultMatchesOperation(item.operation, frame.result.data)) { close(); return; }
    item.finish(frame.result);
  }
  const deadline = setTimeout(close, 10000); deadline.unref();
  const retention = setInterval(sweep, 10000); retention.unref();
  transport.on("message", receive); transport.on("disconnect", close); options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) close(); else send({ type: "shim.ready", shim });
  return {
    signal: controller.signal, close,
    execute(raw: RoutineCliOperation, rawWriter: LinuxProcessIdentity, signal: AbortSignal): Promise<RoutineCliEnvelope> {
      const operation = RoutineCliOperationSchema.parse(raw), writer = TerminalProcessSchema.parse(rawWriter);
      sweep();
      if (!bound || !admissionId || controller.signal.aborted || signal.aborted || pending.size >= 8 || cancelled.size + pending.size >= 256) return Promise.resolve(terminalUnavailable(operation));
      const actionId = randomUUID(), currentAdmission = admissionId;
      return new Promise(resolve => {
        let done = false;
        const finish = (result?: RoutineCliEnvelope) => {
          if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", abort); pending.delete(actionId);
          resolve(result ?? terminalUnavailable(operation));
        };
        const abort = () => {
          cancelled.set(actionId, Date.now() + 120000); finish();
          send({ type: "terminal.cancel", admissionId: currentAdmission, actionId });
        };
        const timer = setTimeout(abort, 120000); timer.unref();
        pending.set(actionId, { operation, finish }); signal.addEventListener("abort", abort, { once: true });
        if (!send({ type: "terminal.call", admissionId: currentAdmission, actionId, writer, operation })) finish();
      });
    },
  };
}
