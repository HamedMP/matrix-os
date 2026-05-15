import { randomUUID } from "node:crypto";
import {
  HERMES_SUBSCRIBER_TTL_MS,
  MAX_HERMES_EVENTS,
  MAX_HERMES_SUBSCRIBERS,
  type HermesStreamEvent,
} from "./contracts.js";

export interface HermesSubscriber {
  id: string;
  ownerId: string;
  send: (event: HermesStreamEvent) => void | Promise<void>;
  close?: () => void | Promise<void>;
}

interface SubscriberRecord extends HermesSubscriber {
  lastTouched: number;
}

export interface HermesEventHub {
  subscribe(subscriber: HermesSubscriber): { ok: true };
  unsubscribe(id: string): void;
  touch(id: string): boolean;
  publish(ownerId: string, event: Omit<HermesStreamEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<HermesStreamEvent>;
  retained(ownerId: string): HermesStreamEvent[];
  size(): number;
  close(): Promise<void>;
}

export interface HermesEventHubOptions {
  maxSubscribers?: number;
  subscriberTtlMs?: number;
  maxEvents?: number;
  maxRetainedOwners?: number;
  now?: () => number;
}

export function createHermesEventHub(options: HermesEventHubOptions = {}): HermesEventHub {
  const maxSubscribers = options.maxSubscribers ?? MAX_HERMES_SUBSCRIBERS;
  const subscriberTtlMs = options.subscriberTtlMs ?? HERMES_SUBSCRIBER_TTL_MS;
  const maxEvents = options.maxEvents ?? MAX_HERMES_EVENTS;
  const maxRetainedOwners = Math.max(1, options.maxRetainedOwners ?? maxSubscribers);
  const now = options.now ?? Date.now;
  const subscribers = new Map<string, SubscriberRecord>();
  const retainedByOwner = new Map<string, HermesStreamEvent[]>();

  function evictStale(): void {
    const cutoff = now() - subscriberTtlMs;
    for (const [id, subscriber] of subscribers) {
      if (subscriber.lastTouched < cutoff) {
        subscribers.delete(id);
        void subscriber.close?.();
      }
    }
  }

  function enforceCap(): void {
    evictStale();
    while (subscribers.size >= maxSubscribers) {
      const [oldestId, oldest] = [...subscribers.entries()].sort((a, b) => a[1].lastTouched - b[1].lastTouched)[0] ?? [];
      if (!oldestId || !oldest) break;
      subscribers.delete(oldestId);
      void oldest.close?.();
    }
  }

  function retain(ownerId: string, event: HermesStreamEvent): void {
    if (!retainedByOwner.has(ownerId)) {
      while (retainedByOwner.size >= maxRetainedOwners) {
        const oldestOwnerId = retainedByOwner.keys().next().value as string | undefined;
        if (!oldestOwnerId) break;
        retainedByOwner.delete(oldestOwnerId);
      }
    }
    const events = retainedByOwner.get(ownerId) ?? [];
    events.push(event);
    retainedByOwner.set(ownerId, events.slice(-maxEvents));
  }

  return {
    subscribe(subscriber) {
      enforceCap();
      subscribers.set(subscriber.id, { ...subscriber, lastTouched: now() });
      return { ok: true };
    },

    unsubscribe(id) {
      subscribers.delete(id);
    },

    touch(id) {
      const subscriber = subscribers.get(id);
      if (!subscriber) return false;
      subscriber.lastTouched = now();
      return true;
    },

    async publish(ownerId, input) {
      evictStale();
      const event: HermesStreamEvent = {
        id: input.id ?? `evt_${randomUUID()}`,
        type: input.type,
        installationId: input.installationId,
        sessionId: input.sessionId,
        payload: input.payload,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      retain(ownerId, event);
      const failed: string[] = [];
      for (const subscriber of subscribers.values()) {
        if (subscriber.ownerId !== ownerId) continue;
        try {
          subscriber.lastTouched = now();
          await subscriber.send(event);
        } catch (err: unknown) {
          console.warn("[hermes] Event subscriber send failed:", err instanceof Error ? err.message : String(err));
          failed.push(subscriber.id);
        }
      }
      for (const id of failed) {
        const subscriber = subscribers.get(id);
        subscribers.delete(id);
        try {
          await subscriber?.close?.();
        } catch (err: unknown) {
          console.warn("[hermes] Event subscriber close failed:", err instanceof Error ? err.message : String(err));
        }
      }
      return event;
    },

    retained(ownerId) {
      return [...(retainedByOwner.get(ownerId) ?? [])];
    },

    size() {
      evictStale();
      return subscribers.size;
    },

    async close() {
      const current = [...subscribers.values()];
      subscribers.clear();
      retainedByOwner.clear();
      await Promise.all(current.map(async (subscriber) => subscriber.close?.()));
    },
  };
}
