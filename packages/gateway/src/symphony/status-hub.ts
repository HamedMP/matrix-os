import { MAX_EVENTS, type OperatorEvent } from "./contracts.js";

export interface SymphonyRealtimeEvent {
  type: string;
  installationId: string;
  runId?: string;
  sequence: number;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface SymphonySubscriber {
  id: string;
  ownerId: string;
  send(event: SymphonyRealtimeEvent): void | Promise<void>;
  close?(): void | Promise<void>;
}

const DEFAULT_MAX_SUBSCRIBERS = 100;
const DEFAULT_MAX_OWNERS = 100;
const DEFAULT_TTL_MS = 5 * 60_000;

export function createSymphonyStatusHub(options: {
  maxSubscribers?: number;
  subscriberTtlMs?: number;
  now?: () => number;
} = {}) {
  const maxSubscribers = options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
  const maxOwners = DEFAULT_MAX_OWNERS;
  const subscriberTtlMs = options.subscriberTtlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const subscribers = new Map<string, SymphonySubscriber & { lastTouched: number }>();
  const sequences = new Map<string, number>();
  const retained = new Map<string, SymphonyRealtimeEvent[]>();

  function sweep(): void {
    const cutoff = now() - subscriberTtlMs;
    for (const [id, subscriber] of subscribers) {
      if (subscriber.lastTouched < cutoff) subscribers.delete(id);
    }
    while (subscribers.size > maxSubscribers) {
      const oldest = subscribers.keys().next().value as string | undefined;
      if (!oldest) break;
      subscribers.delete(oldest);
    }
    while (retained.size > maxOwners) {
      const oldestOwner = retained.keys().next().value as string | undefined;
      if (!oldestOwner) break;
      retained.delete(oldestOwner);
      sequences.delete(oldestOwner);
    }
  }

  async function publish(ownerId: string, event: Omit<SymphonyRealtimeEvent, "sequence">): Promise<SymphonyRealtimeEvent> {
    sweep();
    const sequence = (sequences.get(ownerId) ?? 0) + 1;
    sequences.set(ownerId, sequence);
    const full: SymphonyRealtimeEvent = { ...event, sequence };
    const ownerEvents = retained.get(ownerId) ?? [];
    ownerEvents.push(full);
    retained.set(ownerId, ownerEvents.slice(-MAX_EVENTS));
    const dead: string[] = [];
    await Promise.all(Array.from(subscribers.entries()).map(async ([id, subscriber]) => {
      if (subscriber.ownerId !== ownerId) return;
      try {
        subscriber.lastTouched = now();
        await subscriber.send(full);
      } catch (err: unknown) {
        console.warn("[symphony] status subscriber send failed:", err instanceof Error ? err.message : String(err));
        dead.push(id);
      }
    }));
    for (const id of dead) subscribers.delete(id);
    return full;
  }

  return {
    subscribe(subscriber: SymphonySubscriber): { ok: true } | { ok: false; code: "subscriber_limit" } {
      sweep();
      if (!subscribers.has(subscriber.id) && subscribers.size >= maxSubscribers) {
        return { ok: false, code: "subscriber_limit" };
      }
      subscribers.set(subscriber.id, { ...subscriber, lastTouched: now() });
      return { ok: true };
    },

    unsubscribe(id: string): void {
      subscribers.delete(id);
    },

    async publishOperatorEvent(ownerId: string, event: OperatorEvent): Promise<SymphonyRealtimeEvent> {
      return publish(ownerId, {
        type: event.type,
        installationId: event.installationId,
        runId: event.runId,
        createdAt: event.createdAt,
        payload: {
          message: event.message,
          severity: event.severity,
          metadata: event.metadata ?? {},
        },
      });
    },

    retained(ownerId: string): SymphonyRealtimeEvent[] {
      return [...(retained.get(ownerId) ?? [])];
    },

    size(): number {
      sweep();
      return subscribers.size;
    },

    async close(): Promise<void> {
      const closing = Array.from(subscribers.values());
      subscribers.clear();
      await Promise.all(closing.map(async (subscriber) => {
        try {
          await subscriber.close?.();
        } catch (err: unknown) {
          console.warn("[symphony] status subscriber close failed:", err instanceof Error ? err.message : String(err));
        }
      }));
    },
  };
}

export type SymphonyStatusHub = ReturnType<typeof createSymphonyStatusHub>;
