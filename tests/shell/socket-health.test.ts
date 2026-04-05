import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("SocketHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("heartbeat", () => {
    it("sends ping at configured interval", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      const sent: string[] = [];
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: (data) => sent.push(data),
        onDead: () => {},
      });

      health.start();
      vi.advanceTimersByTime(30_000);

      expect(sent).toContain('{"type":"ping"}');
      health.stop();
    });

    it("calls onDead if no pong received within timeout", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      let dead = false;
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: () => {},
        onDead: () => { dead = true; },
      });

      health.start();
      vi.advanceTimersByTime(30_000); // ping sent
      vi.advanceTimersByTime(5_000);  // pong timeout

      expect(dead).toBe(true);
      health.stop();
    });

    it("does not call onDead if pong received in time", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      let dead = false;
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: () => {},
        onDead: () => { dead = true; },
      });

      health.start();
      vi.advanceTimersByTime(30_000); // ping sent
      health.receivedPong();           // pong arrives
      vi.advanceTimersByTime(5_000);   // would have timed out

      expect(dead).toBe(false);
      health.stop();
    });

    it("stop clears all timers", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      let dead = false;
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: () => {},
        onDead: () => { dead = true; },
      });

      health.start();
      health.stop();
      vi.advanceTimersByTime(60_000);

      expect(dead).toBe(false);
    });

    it("sends multiple pings over successive intervals", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      const sent: string[] = [];
      const health = createSocketHealth({
        pingIntervalMs: 10_000,
        pongTimeoutMs: 5_000,
        send: (data) => sent.push(data),
        onDead: () => {},
      });

      health.start();
      vi.advanceTimersByTime(10_000);
      health.receivedPong();
      vi.advanceTimersByTime(10_000);
      health.receivedPong();
      vi.advanceTimersByTime(10_000);

      expect(sent.length).toBe(3);
      expect(sent.every((s) => s === '{"type":"ping"}')).toBe(true);
      health.stop();
    });

    it("pingNow sends an immediate ping", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      const sent: string[] = [];
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: (data) => sent.push(data),
        onDead: () => {},
      });

      health.pingNow();
      expect(sent).toEqual(['{"type":"ping"}']);
      health.stop();
    });

    it("pingNow does not send if already waiting for pong", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      const sent: string[] = [];
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: (data) => sent.push(data),
        onDead: () => {},
      });

      health.pingNow();
      health.pingNow(); // should be ignored
      expect(sent.length).toBe(1);
      health.stop();
    });

    it("start resets any existing timers", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      let deadCount = 0;
      const health = createSocketHealth({
        pingIntervalMs: 10_000,
        pongTimeoutMs: 5_000,
        send: () => {},
        onDead: () => { deadCount++; },
      });

      health.start();
      vi.advanceTimersByTime(5_000);
      health.start(); // restart mid-cycle
      vi.advanceTimersByTime(10_000); // first ping from new cycle
      health.receivedPong();
      vi.advanceTimersByTime(10_000); // second ping
      vi.advanceTimersByTime(5_000);  // timeout

      expect(deadCount).toBe(1);
      health.stop();
    });
  });

  describe("message queue", () => {
    it("queues messages when not connected", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

      queue.enqueue('{"type":"message","text":"hello"}');
      queue.enqueue('{"type":"message","text":"world"}');

      expect(queue.size).toBe(2);
    });

    it("drains queued messages in order", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

      queue.enqueue("a");
      queue.enqueue("b");
      queue.enqueue("c");

      const drained = queue.drain();
      expect(drained).toEqual(["a", "b", "c"]);
      expect(queue.size).toBe(0);
    });

    it("drops messages older than TTL", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

      queue.enqueue("old");
      vi.advanceTimersByTime(31_000);
      queue.enqueue("new");

      const drained = queue.drain();
      expect(drained).toEqual(["new"]);
    });

    it("enforces max size by dropping oldest", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 3, ttlMs: 30_000 });

      queue.enqueue("a");
      queue.enqueue("b");
      queue.enqueue("c");
      queue.enqueue("d"); // drops "a"

      const drained = queue.drain();
      expect(drained).toEqual(["b", "c", "d"]);
    });

    it("drain returns empty array on empty queue", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

      expect(queue.drain()).toEqual([]);
    });

    it("drain removes all entries from the queue", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

      queue.enqueue("a");
      queue.enqueue("b");
      queue.drain();

      expect(queue.size).toBe(0);
      expect(queue.drain()).toEqual([]);
    });

    it("drops all expired messages on drain", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 50, ttlMs: 5_000 });

      queue.enqueue("a");
      queue.enqueue("b");
      vi.advanceTimersByTime(6_000);

      expect(queue.drain()).toEqual([]);
    });
  });

  describe("reconnect backoff", () => {
    it("calculates exponential delays: 1s, 2s, 4s, 8s, 16s", async () => {
      const { reconnectDelay } = await import("../../shell/src/lib/socket-health.js");

      expect(reconnectDelay(0)).toBe(1000);
      expect(reconnectDelay(1)).toBe(2000);
      expect(reconnectDelay(2)).toBe(4000);
      expect(reconnectDelay(3)).toBe(8000);
      expect(reconnectDelay(4)).toBe(16000);
    });

    it("caps at 16s for attempts beyond 4", async () => {
      const { reconnectDelay } = await import("../../shell/src/lib/socket-health.js");

      expect(reconnectDelay(5)).toBe(16000);
      expect(reconnectDelay(10)).toBe(16000);
      expect(reconnectDelay(100)).toBe(16000);
    });
  });
});
