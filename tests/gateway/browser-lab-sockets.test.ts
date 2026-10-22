import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", () => ({
  WebSocket: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    pause = vi.fn(); resume = vi.fn(); send = vi.fn(); terminate = vi.fn();
    constructor(public url: string, public protocols: string[], public options: any) {
      super(); sockets.push(this);
    }
  },
}));
import { createViewerSockets } from "../../packages/gateway/src/browser-lab/viewer-sockets.js";

const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); sockets.length = 0; });
afterEach(() => { cleanups.splice(0).forEach((close) => close()); vi.useRealTimers(); });
function setup() { const pool = createViewerSockets("Basic c3ludGhldGljOm9ubHk="); cleanups.push(pool.close); return pool; }
async function connect(pool: ReturnType<typeof createViewerSockets>, expiresAt = Date.now() + 60_000) {
  const pending = pool.connect(expiresAt);
  sockets.at(-1).emit("open");
  const events = (await pending)!;
  const client = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
  events.onOpen?.({} as any, client as any);
  return { events, client, upstream: sockets.at(-1) };
}
describe("bounded full-desktop viewer transport", () => {
  it('revokes live and pending transports without permanently closing the pool', async () => {
    const pool = setup(); const existing = await connect(pool);
    const pending = pool.connect(Date.now() + 60_000); const waiting = sockets.at(-1);
    pool.closeConnections(); waiting.emit('open');
    expect(await pending).toBeNull(); expect(existing.client.close).toHaveBeenCalledOnce();
    expect((await connect(pool)).events).not.toBeNull();
  });
  it("refuses transport without a server-only upstream credential", async () => {
    const pool = createViewerSockets(); cleanups.push(pool.close);
    expect(await pool.connect(Date.now() + 60_000)).toBeNull();
    expect(sockets).toHaveLength(0);
  });
  it("connects only the fixed loopback transport before receiving client input", async () => {
    const pool = setup();
    const { events, client, upstream } = await connect(pool);
    expect(upstream.url).toBe("ws://127.0.0.1:6901/websockify");
    expect(upstream.options.headers.Authorization).toBe("Basic c3ludGhldGljOm9ubHk=");
    expect(upstream.options.origin).toBe("http://127.0.0.1:6901");
    expect(upstream.options.maxPayload).toBe(8 * 1024 * 1024);
    expect(upstream.pause).toHaveBeenCalled(); expect(upstream.resume).toHaveBeenCalled();
    const frame = Buffer.from([1, 2, 3]);
    upstream.emit("message", frame, true);
    expect(client.send).toHaveBeenCalledWith(new Uint8Array(frame));
    events.onMessage?.({ data: frame } as any, client as any);
    expect(upstream.send).toHaveBeenCalledWith(frame);
  });
  it("expires established authenticated connections and permits reconnect", async () => {
    const pool = setup();
    const { client, upstream } = await connect(pool, Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(upstream.terminate).toHaveBeenCalled(); expect(client.close).toHaveBeenCalled();
    const replacement = await connect(pool);
    expect(replacement.upstream).not.toBe(upstream);
  });
  it("enforces connection cap, idle eviction, and shutdown drain", async () => {
    const pool = setup();
    const clients = [];
    for (let i = 0; i < 4; i++) clients.push(await connect(pool, Date.now() + 300_000));
    expect(await pool.connect(Date.now() + 300_000)).toBeNull();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(clients.every(({ upstream }) => upstream.terminate.mock.calls.length > 0)).toBe(true);
    const fresh = await connect(pool);
    pool.close();
    expect(fresh.client.close).toHaveBeenCalled();
    expect(await pool.connect(Date.now() + 300_000)).toBeNull();
  });
  it("rejects text frames, oversized input and backpressure before forwarding", async () => {
    for (const data of ["text", new Uint8Array(8 * 1024 * 1024 + 1)]) {
      const pool = setup(); const { events, client, upstream } = await connect(pool);
      events.onMessage?.({ data } as any, client as any);
      expect(upstream.send).not.toHaveBeenCalled(); expect(client.close).toHaveBeenCalled();
    }
    const pool = setup(); const { upstream, client } = await connect(pool);
    client.raw.bufferedAmount = 17 * 1024 * 1024;
    upstream.emit("message", Buffer.from([1]), true);
    expect(client.send).not.toHaveBeenCalled(); expect(upstream.terminate).toHaveBeenCalled();
  });
  it("normalizes failed handshake and expires an abandoned client upgrade", async () => {
    const pool = setup(); const pending = pool.connect(Date.now() + 60_000);
    sockets.at(-1).emit("error", new Error("private failure"));
    expect(await pending).toBeNull();
    const abandoned = pool.connect(Date.now() + 60_000); const upstream = sockets.at(-1);
    upstream.emit("open"); expect(await abandoned).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5000); expect(upstream.terminate).toHaveBeenCalled();
  });
});
