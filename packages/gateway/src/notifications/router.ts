import type { Kysely } from "kysely";
import type { NotificationPreferences } from "@matrix-os/contracts";
import type { ChatOutboxSink } from "../chat/outbox-delivery.js";
import type { NotificationDatabase } from "./schema.js";
import { createAttentionRequestSource } from "./request-source.js";
import { createNotificationRepository, type NotificationEvent } from "./repository.js";
import { attentionPush, NotificationDeferredError, type NotificationTransport } from "./copy.js";

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
  type Work = { chatId: string; refs?: string[] };
  const queue: Work[] = []; // Source references only; capped at 1,000 and removed by the single worker.
  const spills = new Set<Promise<void>>(); // At most four direct overflow writes; removed when settled and drained on close.
  let closed = false, storageOpen = true, closing: Promise<void> | undefined;
  let worker: Promise<void> | undefined, ticking: Promise<void> | undefined, reconciling: Promise<void> | undefined;
  let overflow = false;
  const timers: ReturnType<typeof setInterval>[] = []; // Exactly three, cleared on close.
  const warn = (error: unknown) => (options.logger ?? console).warn(`[notifications] Delivery unavailable: ${error instanceof Error ? error.name : "UnknownError"}`);

  async function ingest(work?: Work) {
    for (const request of await source.list(now(), { ...work, missingOnly: true })) {
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
    // The real outbox strips activityIds and publishes committed activities in streamContent.
    const content = event.payload.streamContent;
    const activities = content && typeof content === "object" && "activities" in content && Array.isArray(content.activities)
      ? content.activities : undefined;
    const refs = activities?.slice(0, 100).flatMap((activity: unknown) => {
      if (!activity || typeof activity !== "object" || !("type" in activity) || !("id" in activity)
        || !["approval.requested", "input.requested"].includes(String(activity.type)) || typeof activity.id !== "string" || activity.id.length > 160) return [];
      return [activity.id];
    });
    if (event.eventType === "run.activity" && refs?.length === 0) return;
    const work = { chatId: event.chatId, ...(refs?.length ? { refs } : {}) };
    if (queue.length < 1000) queue.push(work);
    else if (spills.size < 4) {
      const spill = ingest(work).catch(warn).finally(() => { spills.delete(spill); });
      spills.add(spill);
    } else overflow = true; // Durable source journal covers bursts beyond the four overflow writes, with no unbounded waiters.
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
      // A submitted answer may still fail delivery and reopen this same request.
      if (pending.answerInFlight) { await repository.defer(event, now() + 2000); return; }
      if (!enabled() || !await repository.stillClaimed(event)) return;
      await options.transport.send(attentionPush(event, pending, preferences));
      if (storageOpen) await repository.finish(event, "pushed", now());
    } catch (error: unknown) {
      if (storageOpen && error instanceof NotificationDeferredError) { await repository.defer(event, error.retryAt); return; }
      warn(error);
      if (storageOpen) await repository.retry(event, now());
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
    close(): Promise<void> {
      if (closing) return closing;
      closed = true; for (const timer of timers.splice(0)) clearInterval(timer); queue.length = 0;
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([Promise.allSettled([worker, ticking, reconciling, ...spills]), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
        finally { storageOpen = false; if (timer) clearTimeout(timer); }
      })();
      return closing;
    },
  };
}
