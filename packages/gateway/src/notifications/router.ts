import type { Kysely } from "kysely";
import type { NotificationPreferences } from "@matrix-os/contracts";
import type { ChatOutboxSink } from "../chat/outbox-delivery.js";
import type { NotificationDatabase } from "./schema.js";
import { createAttentionRequestSource } from "./request-source.js";
import { createNotificationRepository, type NotificationEvent } from "./repository.js";
import { attentionPush, type NotificationTransport } from "./copy.js";

export interface NotificationRouterOptions {
  db: Kysely<NotificationDatabase>; ownerId: string;
  preferences(): Promise<NotificationPreferences>; transport: NotificationTransport;
  now?: () => number; enabled?: () => boolean; logger?: Pick<Console, "warn">;
}
export function createNotificationRouter(options: NotificationRouterOptions) {
  const source = createAttentionRequestSource(options.db, options.ownerId);
  const repository = createNotificationRepository(options.db, options.ownerId);
  const now = options.now ?? Date.now;
  const enabled = () => !closed && (options.enabled?.() ?? true);
  const queue: string[] = []; // Chat references only; capped at 1,000 and removed by the single worker.
  let closed = false, worker: Promise<void> | undefined, ticking: Promise<void> | undefined, reconciling: Promise<void> | undefined;
  let overflow = false;
  const timers: ReturnType<typeof setInterval>[] = []; // Exactly three, cleared on close.
  const warn = (error: unknown) => (options.logger ?? console).warn(`[notifications] Delivery unavailable: ${error instanceof Error ? error.name : "UnknownError"}`);

  async function ingest(chatId?: string) {
    for (const request of await source.list(now(), { chatId, missingOnly: true })) {
      if (closed) return;
      await repository.insert(request);
    }
  }
  function flush(): Promise<void> {
    if (worker) return worker;
    worker = (async () => {
      while (queue.length && !closed) await ingest(queue.shift());
      if (overflow && !closed) { overflow = false; await ingest(); }
    })().finally(() => { worker = undefined; if (queue.length && !closed) void flush().catch(warn); });
    return worker;
  }
  const onChatEvent: ChatOutboxSink = ({ owner, event }) => {
    if (!enabled() || owner.type !== "personal" || owner.ownerId !== options.ownerId
      || !["run.activity", "interaction.requested"].includes(event.eventType)) return;
    if (queue.length < 1000) queue.push(event.chatId);
    else overflow = true; // Durable chat rows are the overflow journal; the worker/reconciler persists them.
    void flush().catch(warn);
  };
  async function deliver(event: NotificationEvent) {
    if (!enabled()) return;
    try {
      const preferences = await options.preferences();
      if (!preferences.events[event.kind] || preferences.phone.mode === "never") {
        await repository.finish(event, "suppressed", now()); return;
      }
      const pending = await source.pending(event, now());
      if (!pending) { await repository.finish(event, "resolved", now()); return; }
      if (!enabled() || !await repository.stillClaimed(event)) return;
      await options.transport.send(attentionPush(event, pending, preferences));
      if (!closed) await repository.finish(event, "pushed", now());
    } catch (error: unknown) {
      warn(error);
      if (!closed) await repository.retry(event, now());
    }
  }
  function tick(): Promise<void> {
    if (ticking) return ticking;
    if (!enabled()) return Promise.resolve();
    ticking = (async () => {
      const due = await repository.claim(now());
      for (let offset = 0; offset < due.length && !closed; offset += 4) await Promise.all(due.slice(offset, offset + 4).map(deliver));
    })().finally(() => { ticking = undefined; });
    return ticking;
  }
  function reconcile(): Promise<void> {
    if (reconciling) return reconciling;
    if (!enabled()) return Promise.resolve();
    reconciling = ingest().finally(() => { reconciling = undefined; });
    return reconciling;
  }
  return { onChatEvent, flush, tick, reconcile,
    start() {
      if (closed || timers.length) return;
      void reconcile().catch(warn);
      for (const [work, interval] of [[tick, 2000], [reconcile, 30_000], [() => repository.sweep(now()), 3_600_000]] as const) {
        const timer = setInterval(() => { void work().catch(warn); }, interval); timer.unref?.(); timers.push(timer);
      }
    },
    async close() {
      if (closed) return;
      closed = true; for (const timer of timers.splice(0)) clearInterval(timer); queue.length = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled([worker, ticking, reconciling]), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
      finally { if (timer) clearTimeout(timer); }
    },
  };
}
