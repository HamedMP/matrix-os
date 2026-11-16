import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalHostChannel } from "../../../packages/gateway/src/terminal/host-channel.js";
import { TerminalShimFrameSchema } from "../../../packages/gateway/src/coding-agents/terminal-launch-protocol.mjs";
const digest = "a".repeat(64), generation = "gen_" + "b".repeat(64), admissionId = randomUUID();
const supervisor = { pid: 10, ppid: 1, uid: 1000, gid: 1000, start: "10" }, host = { ...supervisor, pid: 20, ppid: 10, start: "20" }, root = { ...host, pid: 30, ppid: 20, start: "30" };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
function fixture(identity = async () => ({ supervisor, host, root, invocationId: "c".repeat(32) })) {
  const frames: unknown[] = [], transport = Object.assign(new EventEmitter(), { connected: true,
    send(frame: unknown, callback: (error?: Error | null) => void) { frames.push(TerminalShimFrameSchema.parse(frame)); callback(); return true; } });
  transport.on("disconnect", () => { transport.connected = false; });
  const controller = new AbortController(), channel = createTerminalHostChannel({ transport, digest, generation, identity, signal: controller.signal });
  cleanup.push(channel.close);
  const shim = (frames[0] as { shim: string }).shim;
  const ready = () => transport.emit("message", { type: "host.ready", wrapper: randomUUID(), shim, digest });
  const admit = () => transport.emit("message", { type: "host.terminal.admit", admissionId });
  return { channel, transport, frames, controller, ready, admit };
}
describe("host-held Terminal private channel (named IPC fixture, no Matrix authority)", () => {
  it("waits for the exact handshake then binds once to the actual retained identity callback", async () => {
    const identity = vi.fn(async () => ({ supervisor, host, root, invocationId: "c".repeat(32) }));
    const f = fixture(identity); expect(identity).not.toHaveBeenCalled();
    f.ready(); f.admit(); await vi.waitFor(() => expect(f.frames).toHaveLength(2));
    expect(f.frames[1]).toEqual({ type: "terminal.bound", admissionId, supervisor, host, root, invocationId: "c".repeat(32), generation });
    f.admit(); expect(f.channel.signal.aborted).toBe(true); expect(identity).toHaveBeenCalledOnce();
  });
  it.each(["early EOF", "wrong digest", "malformed", "oversized"])("fences %s without workload lifecycle authority", async fault => {
    const f = fixture();
    if (fault === "early EOF") f.transport.emit("disconnect");
    else if (fault === "wrong digest") f.transport.emit("message", { type: "host.ready", wrapper: randomUUID(), shim: (f.frames[0] as { shim: string }).shim, digest: "d".repeat(64) });
    else f.transport.emit("message", fault === "oversized" ? { data: "x".repeat(200000) } : {});
    expect(f.channel.signal.aborted).toBe(true); expect(f.controller.signal.aborted).toBe(false);
    await expect(f.channel.execute({ operation: "list" }, root, new AbortController().signal)).resolves.toMatchObject({ error: { code: "unavailable" } });
  });
  it("late EOF fences pending work and rejects late binding, leaving host owner signal untouched", async () => {
    let resolve!: (value: { supervisor: typeof supervisor; host: typeof host; root: typeof root; invocationId: string }) => void;
    const f = fixture(() => new Promise(done => { resolve = done; }));
    f.ready(); f.admit(); await vi.waitFor(() => expect(resolve).toBeTypeOf("function")); f.transport.emit("disconnect"); resolve({ supervisor, host, root, invocationId: "c".repeat(32) });
    await Promise.resolve(); await Promise.resolve(); expect(f.frames).toHaveLength(1); expect(f.controller.signal.aborted).toBe(false);
  });
  it("caps owner waits, cancels exact actions, keeps UUID uncertainty and fences replayed results", async () => {
    const f = fixture(); f.ready(); f.admit(); await vi.waitFor(() => expect(f.frames).toHaveLength(2));
    const requestId = randomUUID(), operation = { operation: "pause", routineId: "rt_" + "a".repeat(24), baseRevision: 1, requestId } as const;
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const pending = controllers.map(controller => f.channel.execute(operation, root, controller.signal));
    await expect(f.channel.execute(operation, root, new AbortController().signal)).resolves.toMatchObject({ data: { kind: "unknown", requestId } });
    const call = f.frames[2] as { actionId: string }; controllers[0]!.abort();
    expect(f.frames).toContainEqual({ type: "terminal.cancel", admissionId, actionId: call.actionId });
    await expect(pending[0]).resolves.toMatchObject({ data: { kind: "unknown", requestId } });
    // A late reply to a cancelled action cannot be interpreted as new work.
    f.transport.emit("message", { type: "host.terminal.result", admissionId, actionId: call.actionId, result: { v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } } });
    expect(f.channel.signal.aborted).toBe(false);
    const active = f.frames[3] as { actionId: string }, result = { v: 1, error: { code: "permission_denied", message: "This routine operation is not permitted." } };
    f.transport.emit("message", { type: "host.terminal.result", admissionId, actionId: active.actionId, result });
    await expect(pending[1]).resolves.toEqual(result);
    f.transport.emit("message", { type: "host.terminal.result", admissionId, actionId: active.actionId, result });
    expect(f.channel.signal.aborted).toBe(true); await Promise.all(pending);
  });
});
