import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkflowSocketRegistry } from "../e2e/desktop/fixtures/workflow-socket-registry";

class Transport extends EventEmitter {
  destroyed = false;
  readableEnded = false;
  writableEnded = false;
  setKeepAlive = vi.fn();
  destroy = vi.fn(() => { this.destroyed = true; return this; });
}
const pair = () => [new Transport(), new Transport()] as const;
const admit = (registry: ReturnType<typeof createWorkflowSocketRegistry>, sockets: ReturnType<typeof pair>) =>
  registry.add(sockets[0] as unknown as Socket, sockets[1] as unknown as Socket);
afterEach(() => vi.useRealTimers());

it("recovers a stale slot without a close event before enforcing admission capacity", () => {
  const registry = createWorkflowSocketRegistry();
  const sockets = Array.from({ length: 64 }, pair);
  try {
    sockets.forEach(value => expect(admit(registry, value)).toBe(true));
    const excess = pair(); expect(admit(registry, excess)).toBe(false);
    expect(excess.every(socket => socket.destroyed)).toBe(true);
    expect(() => excess[1].emit("error", new Error("queued teardown"))).not.toThrow();
    sockets[0]![0].destroyed = true; // A missing close callback must not retain its paired slot.
    expect(admit(registry, pair())).toBe(true);
    expect(sockets[0]![1].destroy).toHaveBeenCalledOnce();
    expect(sockets.slice(1).every(value => value.every(socket => !socket.destroyed))).toBe(true);
  } finally { registry.close(); }
});
it("reclaims a half-open live-looking pair after the fixture idle lifetime without close", () => {
  vi.useFakeTimers();
  const registry = createWorkflowSocketRegistry(); const sockets = Array.from({ length: 64 }, pair);
  try {
    sockets.forEach(value => admit(registry, value));
    vi.advanceTimersByTime(29 * 60_000);
    sockets.slice(1).forEach((value, index) => value[index % 2]!.emit("data", Buffer.from("recent activity")));
    vi.advanceTimersByTime(2 * 60_000);
    expect(sockets[0]!.every(socket => socket.destroyed)).toBe(true);
    expect(admit(registry, pair())).toBe(true);
    expect(sockets.slice(1).every(value => value.every(socket => !socket.destroyed))).toBe(true);
  } finally { registry.close(); }
});
it("sweeps ended transports periodically and keeps healthy idle and bidirectional activity alive", () => {
  vi.useFakeTimers();
  const registry = createWorkflowSocketRegistry();
  const ended = pair(); const idle = pair(); const active = pair();
  try {
    [ended, idle, active].forEach(value => admit(registry, value));
    ended[1].readableEnded = true;
    for (let index = 0; index < 20; index++) {
      active[index % 2]!.emit("data", Buffer.from("synthetic activity"));
      vi.advanceTimersByTime(60_000);
    }
    expect(ended.every(socket => socket.destroyed)).toBe(true);
    expect([...idle, ...active].every(socket => !socket.destroyed)).toBe(true);
    [...idle, ...active].forEach(socket => expect(socket.setKeepAlive).toHaveBeenCalledWith(true, 10_000));
  } finally { registry.close(); }
});
it("drains paired transports and clears periodic cleanup on shutdown", () => {
  vi.useFakeTimers();
  const baseline = vi.getTimerCount();
  const registry = createWorkflowSocketRegistry(); const sockets = pair();
  admit(registry, sockets);
  expect(vi.getTimerCount()).toBe(baseline + 1);
  registry.close(); registry.close();
  expect(sockets.every(socket => socket.destroyed)).toBe(true);
  expect(() => sockets[0].emit("error", new Error("queued teardown"))).not.toThrow();
  expect(vi.getTimerCount()).toBe(baseline);
  const late = pair(); expect(admit(registry, late)).toBe(false);
  expect(late.every(socket => socket.destroyed)).toBe(true);
});
