import { CanvasIdSchema } from "./contracts.js";

const DEFAULT_MAX_SUBSCRIBERS = 100;
const DEFAULT_MAX_SUBSCRIBERS_PER_CANVAS_USER = 10;
const DEFAULT_PRESENCE_TTL_MS = 30_000;
const DEFAULT_SUBSCRIBER_TTL_MS = 5 * 60_000;
const MAX_FRAME_BYTES = 32 * 1024;

export interface CanvasSubscriber {
  connectionId: string;
  canvasId: string;
  userId: string;
  send: (message: string) => void;
  lastSeenRevision?: number;
}

export interface CanvasSubscriptionHubOptions {
  maxSubscribers?: number;
  maxSubscribersPerCanvasUser?: number;
  presenceTtlMs?: number;
  subscriberTtlMs?: number;
  authorize?: (subscriber: CanvasSubscriber) => boolean | Promise<boolean>;
  now?: () => number;
}

interface SubscriberState extends CanvasSubscriber {
  lastTouched: number;
  presence: Record<string, unknown> | null;
  presenceUpdatedAt: number;
}

export class CanvasSubscriptionHub {
  private readonly subscribers = new Map<string, SubscriberState>();
  private readonly maxSubscribers: number;
  private readonly maxSubscribersPerCanvasUser: number;
  private readonly presenceTtlMs: number;
  private readonly subscriberTtlMs: number;
  private readonly authorize?: CanvasSubscriptionHubOptions["authorize"];
  private readonly now: () => number;

  constructor(options: CanvasSubscriptionHubOptions = {}) {
    this.maxSubscribers = options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
    this.maxSubscribersPerCanvasUser = options.maxSubscribersPerCanvasUser ?? DEFAULT_MAX_SUBSCRIBERS_PER_CANVAS_USER;
    this.presenceTtlMs = options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
    this.subscriberTtlMs = options.subscriberTtlMs ?? DEFAULT_SUBSCRIBER_TTL_MS;
    this.authorize = options.authorize;
    this.now = options.now ?? Date.now;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  async subscribe(subscriber: CanvasSubscriber): Promise<void> {
    CanvasIdSchema.parse(subscriber.canvasId);
    const authorized = this.authorize ? await this.authorize(subscriber) : true;
    if (!authorized) throw new Error("Unauthorized");
    const now = this.now();
    this.pruneExpiredPresence(now);
    this.evictStaleSubscribers(now);

    if (!this.subscribers.has(subscriber.connectionId) && this.subscribers.size >= this.maxSubscribers) {
      throw new Error("Too many subscribers");
    }

    const existingForCanvasUser = [...this.subscribers.values()].filter(
      (entry) => entry.canvasId === subscriber.canvasId && entry.userId === subscriber.userId && entry.connectionId !== subscriber.connectionId,
    ).length;
    if (existingForCanvasUser >= this.maxSubscribersPerCanvasUser) {
      throw new Error("Too many subscribers");
    }

    this.subscribers.set(subscriber.connectionId, {
      ...subscriber,
      lastTouched: now,
      presence: null,
      presenceUpdatedAt: 0,
    });
  }

  unsubscribe(connectionId: string): void {
    this.subscribers.delete(connectionId);
  }

  validateInboundFrame(frame: string): unknown {
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      throw new Error("Frame too large");
    }
    try {
      return JSON.parse(frame) as unknown;
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.error("[canvas/realtime] Unexpected frame parse failure:", err);
      }
      throw new Error("Invalid frame");
    }
  }

  updatePresence(connectionId: string, presence: Record<string, unknown>): void {
    const subscriber = this.subscribers.get(connectionId);
    if (!subscriber) return;
    subscriber.presence = presence;
    subscriber.presenceUpdatedAt = this.now();
    subscriber.lastTouched = subscriber.presenceUpdatedAt;
  }

  presenceForCanvas(canvasId: string): Array<{ connectionId: string; userId: string; presence: Record<string, unknown> }> {
    const now = this.now();
    const result: Array<{ connectionId: string; userId: string; presence: Record<string, unknown> }> = [];
    this.pruneExpiredPresence(now);

    for (const [connectionId, subscriber] of this.subscribers) {
      if (subscriber.canvasId === canvasId && subscriber.presence) {
        result.push({ connectionId, userId: subscriber.userId, presence: subscriber.presence });
      }
    }

    return result;
  }

  broadcast(canvasId: string, message: unknown): void {
    const payload = JSON.stringify(message);
    this.pruneExpiredPresence();
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.canvasId === canvasId) {
        try {
          subscriber.send(payload);
          subscriber.lastTouched = this.now();
        } catch (err: unknown) {
          console.error("[canvas/realtime] Broadcast send failed:", err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  sendSafeError(connectionId: string, err: unknown): void {
    const subscriber = this.subscribers.get(connectionId);
    if (!subscriber) return;
    console.error("[canvas/realtime] Realtime error:", err instanceof Error ? err.message : String(err));
    try {
      subscriber.send(JSON.stringify({ type: "error", error: "Canvas realtime failed" }));
    } catch (sendErr: unknown) {
      console.error("[canvas/realtime] Error response send failed:", sendErr instanceof Error ? sendErr.message : String(sendErr));
    }
  }

  private pruneExpiredPresence(now = this.now()): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.presence && now - subscriber.presenceUpdatedAt > this.presenceTtlMs) {
        subscriber.presence = null;
      }
    }
  }

  private evictStaleSubscribers(now = this.now()): void {
    for (const [connectionId, subscriber] of this.subscribers) {
      if (now - subscriber.lastTouched > this.subscriberTtlMs) {
        this.subscribers.delete(connectionId);
      }
    }
  }
}
