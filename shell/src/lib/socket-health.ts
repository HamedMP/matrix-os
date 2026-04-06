export interface SocketHealthConfig {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  send: (data: string) => void;
  onDead: () => void;
}

export function createSocketHealth(config: SocketHealthConfig) {
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;

  function sendPing() {
    config.send(JSON.stringify({ type: "ping" }));
    pongTimer = setTimeout(() => {
      pongTimer = null;
      config.onDead();
    }, config.pongTimeoutMs);
  }

  return {
    start() {
      this.stop();
      pingTimer = setInterval(sendPing, config.pingIntervalMs);
    },

    stop() {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    },

    receivedPong() {
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    },

    /** Send an immediate ping (used on visibility change). */
    pingNow() {
      if (pongTimer) return; // already waiting for pong
      sendPing();
    },
  };
}

export interface MessageQueueConfig {
  maxSize: number;
  ttlMs: number;
}

interface QueueEntry {
  data: string;
  enqueuedAt: number;
}

export class MessageQueue {
  private entries: QueueEntry[] = [];
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(config: MessageQueueConfig) {
    this.maxSize = config.maxSize;
    this.ttlMs = config.ttlMs;
  }

  get size(): number {
    return this.entries.length;
  }

  enqueue(data: string): void {
    if (this.entries.length >= this.maxSize) {
      this.entries.shift();
    }
    this.entries.push({ data, enqueuedAt: Date.now() });
  }

  drain(): string[] {
    const now = Date.now();
    const valid = this.entries.filter((e) => now - e.enqueuedAt < this.ttlMs);
    this.entries = [];
    return valid.map((e) => e.data);
  }
}

export function reconnectDelay(attempt: number): number {
  return Math.min(16_000, Math.pow(2, attempt) * 1000);
}
