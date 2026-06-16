export interface SocketHealthConfig {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  send: (data: string) => void;
  onDead: () => void;
}

function shouldEnforcePongTimeout(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function createSocketHealth(config: SocketHealthConfig) {
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenPingAwaitingPong = false;

  function sendPing() {
    config.send(JSON.stringify({ type: "ping" }));
    if (!shouldEnforcePongTimeout()) {
      hiddenPingAwaitingPong = true;
      return;
    }
    hiddenPingAwaitingPong = false;
    pongTimer = setTimeout(() => {
      pongTimer = null;
      if (!shouldEnforcePongTimeout()) {
        return;
      }
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
      hiddenPingAwaitingPong = false;
    },

    receivedPong() {
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      hiddenPingAwaitingPong = false;
    },

    /** Send an immediate ping (used on visibility change). */
    pingNow() {
      if (pongTimer) return; // already waiting for pong
      if (hiddenPingAwaitingPong && !shouldEnforcePongTimeout()) return;
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
