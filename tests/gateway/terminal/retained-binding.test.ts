import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createRetainedTerminalBinding, type TerminalSourcePort } from "../../../packages/gateway/src/terminal/retained-binding.js";
import type { TerminalLaunchChannel } from "../../../packages/gateway/src/background-launch-channel.js";
import type { TerminalShimFrame, TerminalHostFrame } from "../../../packages/gateway/src/coding-agents/terminal-launch-protocol.mjs";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture(verify = async () => true, onBound?: Parameters<typeof createRetainedTerminalBinding>[0]["onBound"]) {
  let receiver!: (frame: TerminalShimFrame) => void, closed!: () => void;
  const sent: TerminalHostFrame[] = [];
  const channel: TerminalLaunchChannel = { generation: `${randomUUID()}:${randomUUID()}`, send: frame => { sent.push(frame); return true; },
    subscribe: (receive, close) => { receiver = receive; closed = close; return () => {}; }, close: () => { closed?.(); } };
  const binding = createRetainedTerminalBinding({ channel, verify, onBound }); cleanup.push(binding.close);
  const admissionId = (sent[0] as { admissionId: string }).admissionId;
  const supervisor = { pid: 10, ppid: 1, uid: 1000, gid: 1000, start: "10" }, host = { ...supervisor, pid: 20, ppid: 10, start: "20" }, root = { ...host, pid: 30, ppid: 20, start: "30" };
  const bound = { type: "terminal.bound" as const, admissionId, supervisor, host, root, invocationId: "c".repeat(32), generation: "gen_" + "b".repeat(64) };
  return { binding, sent, admissionId, bound, receive: (frame: TerminalShimFrame) => receiver(frame), disconnect: () => closed() };
}
const unavailable = { v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } } as const;
it("never calls trusted source factory when supervisor verification fails", async () => {
  const onBound = vi.fn(), f = fixture(async () => false, onBound); f.receive(f.bound);
  expect(await f.binding.ready).toBe(false); expect(onBound).not.toHaveBeenCalled(); expect(f.binding.signal.aborted).toBe(true);
});
it("fences synchronously on control loss and closes a late source without resurrecting admission", async () => {
  let resolve!: (port: TerminalSourcePort) => void;
  const onBound = vi.fn(() => new Promise<TerminalSourcePort>(done => { resolve = done; }));
  const f = fixture(async () => true, onBound); f.receive(f.bound); await vi.waitFor(() => expect(onBound).toHaveBeenCalledOnce());
  f.disconnect(); expect(f.binding.signal.aborted).toBe(true); expect(await f.binding.ready).toBe(false);
  const port = { invoke: vi.fn(async () => unavailable), end: vi.fn(), close: vi.fn(async () => {}) }; resolve(port);
  await vi.waitFor(() => expect(port.close).toHaveBeenCalledOnce()); expect(port.end).toHaveBeenCalledOnce(); expect(port.invoke).not.toHaveBeenCalled();
});
it("rechecks current binding, cancels an exact pending call and rejects replay without inventing positive authority", async () => {
  const signals: AbortSignal[] = [], port = { end: vi.fn(), close: vi.fn(async () => {}), invoke: vi.fn(async (_operation: unknown, _writer: unknown, signal: AbortSignal) => {
    signals.push(signal); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return unavailable;
  }) };
  const verify = vi.fn(async () => true), f = fixture(verify, async () => port); f.receive(f.bound); expect(await f.binding.ready).toBe(true);
  const actionId = randomUUID(), frame = { type: "terminal.call" as const, admissionId: f.admissionId, actionId, writer: f.bound.root, operation: { operation: "list" as const } };
  f.receive(frame); await vi.waitFor(() => expect(signals).toHaveLength(1)); expect(verify.mock.calls.length).toBeGreaterThanOrEqual(2);
  f.receive({ type: "terminal.cancel", admissionId: f.admissionId, actionId }); expect(signals[0]!.aborted).toBe(true);
  await Promise.resolve(); await Promise.resolve(); expect(f.sent.some(frame => frame.type === "host.terminal.result")).toBe(false);
  f.receive(frame); expect(f.binding.signal.aborted).toBe(true); expect(port.end).toHaveBeenCalledOnce(); expect(port.invoke).toHaveBeenCalledOnce();
});
