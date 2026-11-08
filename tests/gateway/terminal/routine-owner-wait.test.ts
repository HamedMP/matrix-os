import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ROUTINE_CLI_OWNER_WAIT_MS, ROUTINE_CLI_REQUEST_TIMEOUT_MS, type RoutineCliEnvelope, type RoutineCliOperation,
} from "@matrix-os/contracts/routine-cli";
import type { TerminalLaunchChannel } from "../../../packages/gateway/src/background-launch-channel.js";
import type { FixedNativeRoutineCliDependencies } from "../../../packages/gateway/src/bots/routine-cli-invoker.js";
import type { RoutineCliRuntime } from "../../../packages/gateway/src/bots/routine-cli-runtime.js";
import { TerminalShimFrameSchema, type TerminalShimFrame } from "../../../packages/gateway/src/coding-agents/terminal-launch-protocol.mjs";
import { createTerminalHostChannel } from "../../../packages/gateway/src/terminal/host-channel.js";
import { createRetainedTerminalBinding } from "../../../packages/gateway/src/terminal/retained-binding.js";
import { createTerminalRoutineSource } from "../../../packages/gateway/src/terminal/routine-source.js";
import { createTerminalWriterBroker, type TerminalWriterNative } from "../../../packages/gateway/src/terminal/writer-broker.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});

const requestId = "550e8400-e29b-41d4-a716-446655440000";
const routineId = `rt_${"a".repeat(24)}`;
const pause = { operation: "pause", routineId, requestId, baseRevision: 1 } as const;
const receipt = { v: 1, ok: true, data: { kind: "receipt", approval: null, current: null,
  receipt: { requestId, operation: "pause", revision: 2, createdAt: "2026-11-01T00:00:00.000Z",
    disposition: "applied", routine: { routineId, revision: 2, status: "paused" } } } } satisfies RoutineCliEnvelope;

// A named fixed-child boundary fixture. Production broker, held IPC, and
// source authorization/cancellation still run on their normal entry points.
vi.mock("../../../packages/gateway/src/bots/routine-cli-invoker.js", () => ({
  createFixedNativeRoutineCliInvoker: (deps: FixedNativeRoutineCliDependencies) => ({
    async invoke({ expectedOperation, signal }: { expectedOperation: RoutineCliOperation; signal: AbortSignal }): Promise<RoutineCliEnvelope> {
      const allowed = await deps.authorize({ operation: expectedOperation, invocationId: randomUUID(), signal });
      return allowed && !signal.aborted && expectedOperation.operation === "pause" ? receipt
        : { v: 1, error: { code: "permission_denied", message: "This routine operation is not permitted." } };
    },
    async close() {},
  }),
}));

async function fixture(operation: RoutineCliOperation) {
  const directory = await mkdtemp(join(tmpdir(), "terminal-owner-wait-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  vi.useFakeTimers();
  // Native AbortSignal.timeout does not use Vitest's patched JavaScript timers.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const timer = new AbortController();
    setTimeout(() => timer.abort(), ms).unref();
    return timer.signal;
  });
  const digest = "a".repeat(64), generation = `gen_${"b".repeat(64)}`;
  const supervisor = { pid: 10, ppid: 1, uid: 501, gid: 20, start: "10" };
  const host = { ...supervisor, pid: 20, ppid: 10, start: "20" };
  const root = { ...host, pid: 30, ppid: 20, start: "30" };
  const writer = { ...root, pid: 40, ppid: 30, start: "40" };
  const readProcess = async (pid: number) => {
    const identity = [supervisor, host, root, writer].find(candidate => candidate.pid === pid);
    if (!identity) throw new Error("Unexpected fixture process");
    return identity;
  };
  const decision = Promise.withResolvers<boolean>();
  const authorize = vi.fn<FixedNativeRoutineCliDependencies["authorize"]>(async ({ signal }) => {
    if (signal.aborted) return false;
    const stopped = Promise.withResolvers<boolean>();
    const abort = () => stopped.resolve(false);
    signal.addEventListener("abort", abort, { once: true });
    try { return await Promise.race([decision.promise, stopped.promise]); }
    finally { signal.removeEventListener("abort", abort); }
  });
  const cancel = vi.fn(async () => {});
  const register: RoutineCliRuntime["register"] = async input => ({
    source: input.source, reference: { sourceId: `rsrc_${"a".repeat(64)}` }, authorize, cancel,
    issue: async () => { throw new Error("No capability in the transport fixture"); }, revoke: async () => {},
  });

  let receive!: (frame: TerminalShimFrame) => void, shim!: string;
  const outgoing: TerminalShimFrame[] = [];
  const ipc = Object.assign(new EventEmitter(), { connected: true,
    send(raw: unknown, callback: (error?: Error | null) => void) {
      const frame = TerminalShimFrameSchema.parse(raw);
      outgoing.push(frame);
      if (frame.type === "shim.ready") shim = frame.shim;
      else receive(frame);
      callback();
      return true;
    },
  });
  const nativeOwner = new AbortController();
  const channel = createTerminalHostChannel({ transport: ipc, digest, generation, signal: nativeOwner.signal,
    identity: async () => ({ supervisor, host, root, invocationId: "c".repeat(32) }) });
  cleanup.push(channel.close);
  ipc.emit("message", { type: "host.ready", wrapper: randomUUID(), shim, digest });
  const held: TerminalLaunchChannel = {
    generation: `${randomUUID()}:${randomUUID()}`,
    subscribe(receiver) { receive = receiver; return () => {}; },
    send(frame) { ipc.emit("message", frame); return true; },
    close() { ipc.connected = false; ipc.emit("disconnect"); },
  };
  const binding = createRetainedTerminalBinding({ channel: held, verify: async () => true,
    onBound: async startup => createTerminalRoutineSource({ runtime: { register }, computerId: "computer-test",
      binPath: "/unused/matrix.mjs", endpoint: "http://127.0.0.1/api/routine-cli/execute", homePath: directory,
      admission: { principal: { userId: "fixture-owner", source: "jwt" }, harness: "claude", sessionId: "tt_test",
        incarnationId: "ti_test", launchId: "launch_test", generation, supervisor, host, root,
        policy: { live: true, scope: "personal", interactionMode: "default", permissionMode: "supervised", originCeiling: "exact", revision: "1" } },
      signal: startup.signal, current: startup.current, preflightCurrent: startup.verifyCurrent, readProcess }) });
  cleanup.push(binding.close);
  expect(await binding.ready).toBe(true);

  const listener = {}, peer = {};
  const incoming: Array<ReturnType<TerminalWriterNative["receive"]>> = [{ data: Buffer.from(JSON.stringify(operation) + "\n"), writer }];
  const replies: RoutineCliEnvelope[] = [];
  let accepted = false;
  const close = vi.fn();
  const broker = await createTerminalWriterBroker({ directory, root, signal: channel.signal, execute: channel.execute, readProcess,
    native: { listen: () => listener, accept: () => {
      if (accepted) return null;
      accepted = true;
      return { handle: peer, creator: writer };
    }, receive: () => incoming.shift() ?? null, send: (_handle, bytes) => {
      replies.push(JSON.parse(bytes.toString()));
      return bytes.length;
    }, close } });
  cleanup.push(() => broker.close());
  await vi.advanceTimersByTimeAsync(5);
  expect(authorize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation }));
  const signal = authorize.mock.calls[0]![0].signal;
  return { signal, decision, incoming, replies, outgoing, close, peer, cancel, nativeOwner };
}

it("delivers a mutation receipt after an owner answer near the end of the 30-minute source lease", async () => {
  const f = await fixture(pause);
  await vi.advanceTimersByTimeAsync(ROUTINE_CLI_OWNER_WAIT_MS - 1_000);
  expect(f.signal.aborted).toBe(false);
  expect(f.close).not.toHaveBeenCalledWith(f.peer);
  expect(f.outgoing.some(frame => frame.type === "terminal.cancel")).toBe(false);
  expect(f.replies).toEqual([]);

  f.decision.resolve(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(f.replies).toEqual([receipt]);
}, 45_000);

it("keeps a stalled read bounded by the short request budget", async () => {
  const f = await fixture({ operation: "list" });
  await vi.advanceTimersByTimeAsync(ROUTINE_CLI_REQUEST_TIMEOUT_MS - 5);
  expect(f.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(f.signal.aborted).toBe(true);
  expect(f.close).toHaveBeenCalledWith(f.peer);
  expect(f.replies).toEqual([]);
});

it("cancels on writer EOF after two minutes without ending the native workload", async () => {
  const f = await fixture(pause);
  await vi.advanceTimersByTimeAsync(121_000);
  expect(f.signal.aborted).toBe(false);
  f.incoming.push(false);
  await vi.advanceTimersByTimeAsync(5);
  expect(f.signal.aborted).toBe(true);
  expect(f.cancel).toHaveBeenCalledWith(expect.objectContaining({ reason: "aborted" }));
  expect(f.nativeOwner.signal.aborted).toBe(false);

  f.decision.resolve(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(f.replies).toEqual([]);
});
