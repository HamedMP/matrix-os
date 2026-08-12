import type { WebSocketLike } from "@desktop/renderer/src/lib/kernel-socket";
import { KernelSocket } from "@desktop/renderer/src/lib/kernel-socket";

export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { if (this.readyState !== 3) { this.readyState = 3; this.onclose?.(); } }
  open(): void { this.readyState = 1; this.onopen?.(); }
  message(data: unknown): void { this.onmessage?.({ data }); }
  fail(): void { this.close(); }
}

interface ScheduledTimer { id: number; fn: () => void; delay: number; cleared: boolean; fired: boolean }

function createFakeTimers() {
  const scheduled: ScheduledTimer[] = [];
  let nextId = 1;
  const setTimeoutFn = ((fn: () => void, delay?: number) => {
    const timer = { id: nextId++, fn, delay: delay ?? 0, cleared: false, fired: false };
    scheduled.push(timer);
    return timer.id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = ((id?: unknown) => {
    const timer = scheduled.find((candidate) => candidate.id === id);
    if (timer) timer.cleared = true;
  }) as typeof clearTimeout;
  const runNext = () => {
    const timer = scheduled.find((candidate) => !candidate.cleared && !candidate.fired);
    if (!timer) throw new Error("no pending timer");
    timer.fired = true;
    timer.fn();
  };
  const pending = () => scheduled.filter((candidate) => !candidate.cleared && !candidate.fired);
  return { scheduled, setTimeoutFn, clearTimeoutFn, runNext, pending };
}

export function createKernelSocketHarness(overrides?: { runtimeSlot?: string; random?: () => number }) {
  const sockets: FakeWebSocket[] = [];
  const urls: string[] = [];
  const timers = createFakeTimers();
  const socket = new KernelSocket({
    baseUrl: "https://app.matrix-os.com",
    runtimeSlot: overrides?.runtimeSlot ?? "primary",
    createWebSocket: (url) => {
      urls.push(url);
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: overrides?.random ?? (() => 1),
  });
  return { socket, sockets, urls, timers, last: () => sockets[sockets.length - 1]! };
}
