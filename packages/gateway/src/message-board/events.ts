import type { Kysely } from "kysely";
import type { BoardEvent, BoardEventsPage, BoardSocketFrame } from "@matrix-os/contracts/message-board";
import type { MessageBoardDatabase } from "./database.js";
import { boardFail } from "./errors.js";
import { parseActor, toIso, type BoardRow } from "./rows.js";

export interface EventFilter {
  /** `*`, a channel, or a subtree ending in `/`. */
  channel?: string;
  thread?: string;
  /** Per-caller visibility (grants); events the caller cannot read are skipped. */
  canRead?: (event: BoardEvent) => boolean;
}

export function eventMatches(event: BoardEvent, filter: EventFilter): boolean {
  if (filter.thread && event.threadId !== filter.thread) return false;
  const scope = filter.channel;
  if (scope && scope !== "*") {
    if (!event.channel) return false;
    if (scope.endsWith("/")) {
      if (event.channel !== scope.slice(0, -1) && !event.channel.startsWith(scope)) return false;
    } else if (event.channel !== scope) return false;
  }
  return filter.canRead ? filter.canRead(event) : true;
}

/**
 * Events after `after`, oldest first. The returned cursor is the last event
 * scanned (matching or not), so a loop that passes it back never rescans or
 * skips. Without `after` it starts from now. An `after` older than the
 * retained window returns `missed` and resumes from the oldest event kept.
 */
export async function readBoardEvents(
  db: Kysely<MessageBoardDatabase>,
  board: BoardRow,
  options: { after?: string; limit: number } & EventFilter,
): Promise<BoardEventsPage> {
  const latest = String(board.last_cursor);
  if (options.after === undefined) return { events: [], cursor: latest };
  let after = BigInt(options.after);
  let missed = false;
  const oldest = await db.selectFrom("board_events").select((eb) => eb.fn.min("cursor").as("cursor"))
    .where("board_id", "=", board.id).executeTakeFirst();
  const oldestCursor = oldest?.cursor == null ? null : BigInt(String(oldest.cursor));
  if (after > BigInt(latest)) boardFail("invalid_input");
  if (oldestCursor !== null && after < oldestCursor - 1n) {
    missed = true;
    after = oldestCursor - 1n;
  } else if (oldestCursor === null && after < BigInt(latest)) {
    missed = true;
    after = BigInt(latest);
  }
  const rows = await db.selectFrom("board_events").selectAll().where("board_id", "=", board.id)
    .where("cursor", ">", String(after) as never).orderBy("cursor").limit(options.limit).execute();
  const events = rows.map((row): BoardEvent => ({
    cursor: String(row.cursor),
    type: row.type as BoardEvent["type"],
    board: board.name,
    createdAt: toIso(row.created_at)!,
    actor: parseActor(row.actor),
    ...(row.channel ? { channel: row.channel } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.payload && Object.keys(row.payload as object).length ? { payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<string, unknown> } : {}),
  }));
  const cursor = events.at(-1)?.cursor ?? String(after);
  return { events: events.filter((event) => eventMatches(event, options)), cursor, ...(missed ? { missed: true } : {}) };
}

/* ---------------- live hub ---------------- */

const DEFAULTS = {
  maxSubscribers: 256, maxPerBoard: 32, maxPerActor: 8, maxWaiters: 128,
  heartbeatMs: 15_000, staleMs: 60_000, maxBacklogBytes: 1024 * 1024, maxBuffered: 1_000,
};

export interface BoardSubscriberSpec extends EventFilter {
  ownerId: string;
  boardName: string;
  actorId: string;
  send(frame: BoardSocketFrame): void;
  close(): void;
  /** Bytes queued on the transport. */
  backlog?(): number;
}

interface Subscriber extends BoardSubscriberSpec {
  id: number;
  lastTouched: number;
  /** While replaying from the database, live events are held here. */
  buffer: BoardEvent[] | null;
  delivered: string;
}

export interface BoardSubscriptionHandle {
  touch(): void;
  /** Ends replay: delivers held live events after `cursor`, then streams live. */
  live(cursor: string): void;
  close(): void;
}

/**
 * Live board events for sockets and long-polls. Bounded per gateway, per board
 * and per actor; silent subscribers are evicted after 60 s, failed sends after
 * the broadcast, and a subscriber more than 1 MiB behind gets `missed` and is
 * closed so it resumes from its cursor.
 */
export class BoardEventHub {
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly waiters: Array<{ key: string; resolve(): void }> = [];
  private readonly options: typeof DEFAULTS;
  private readonly now: () => number;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private closed = false;

  constructor(options: Partial<typeof DEFAULTS> & { now?: () => number } = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.now = options.now ?? Date.now;
  }

  size(): number { return this.subscribers.size; }
  waiting(): number { return this.waiters.length; }

  subscribe(spec: BoardSubscriberSpec): BoardSubscriptionHandle {
    if (this.closed) boardFail("unavailable");
    this.evictStale();
    const key = boardKey(spec.ownerId, spec.boardName);
    const all = [...this.subscribers.values()];
    if (all.length >= this.options.maxSubscribers
      || all.filter((item) => boardKey(item.ownerId, item.boardName) === key).length >= this.options.maxPerBoard
      || all.filter((item) => item.actorId === spec.actorId).length >= this.options.maxPerActor) {
      boardFail("unavailable");
    }
    const subscriber: Subscriber = { ...spec, id: this.nextId++, lastTouched: this.now(), buffer: [], delivered: "0" };
    this.subscribers.set(subscriber.id, subscriber);
    this.ensureHeartbeat();
    return {
      touch: () => { subscriber.lastTouched = this.now(); },
      live: (cursor) => {
        const held = subscriber.buffer ?? [];
        subscriber.buffer = null;
        subscriber.delivered = cursor;
        this.deliver(subscriber, held.filter((event) => BigInt(event.cursor) > BigInt(cursor)));
      },
      close: () => this.remove(subscriber.id),
    };
  }

  publish(ownerId: string, events: readonly BoardEvent[]): void {
    if (events.length === 0) return;
    const key = boardKey(ownerId, events[0]!.board);
    for (const waiter of this.waiters.filter((item) => item.key === key)) waiter.resolve();
    const failed: Subscriber[] = [];
    for (const subscriber of this.subscribers.values()) {
      if (boardKey(subscriber.ownerId, subscriber.boardName) !== key) continue;
      if (subscriber.buffer) {
        subscriber.buffer.push(...events);
        if (subscriber.buffer.length > this.options.maxBuffered) this.markMissed(subscriber, failed);
        continue;
      }
      if (!this.deliver(subscriber, events)) failed.push(subscriber);
    }
    for (const subscriber of failed) this.remove(subscriber.id);
  }

  /** Resolves on the next event for the board, or after `timeoutMs`. */
  waitForEvents(ownerId: string, boardName: string, timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.waiters.length >= this.options.maxWaiters) boardFail("unavailable");
    return new Promise((resolve) => {
      const waiter = {
        key: boardKey(ownerId, boardName),
        resolve: () => {
          clearTimeout(timer);
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          resolve();
        },
      };
      const timer = setTimeout(waiter.resolve, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Shutdown drain: tell every subscriber, close them, and release waiters. */
  shutdown(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const subscriber of [...this.subscribers.values()]) {
      this.safeSend(subscriber, { type: "shutdown" });
      this.remove(subscriber.id);
    }
    for (const waiter of [...this.waiters]) waiter.resolve();
  }

  /** One heartbeat round; exposed for tests. */
  tick(): void {
    this.evictStale();
    const failed = [...this.subscribers.values()].filter((subscriber) => !this.safeSend(subscriber, { type: "heartbeat" }));
    for (const subscriber of failed) this.remove(subscriber.id);
  }

  private deliver(subscriber: Subscriber, events: readonly BoardEvent[]): boolean {
    for (const event of events) {
      if (BigInt(event.cursor) <= BigInt(subscriber.delivered)) continue;
      subscriber.delivered = event.cursor;
      if (!eventMatches(event, subscriber)) continue;
      if ((subscriber.backlog?.() ?? 0) > this.options.maxBacklogBytes) {
        this.safeSend(subscriber, { type: "missed", cursor: previousCursor(event.cursor) });
        return false;
      }
      if (!this.safeSend(subscriber, { type: "event", event })) return false;
    }
    return true;
  }

  private markMissed(subscriber: Subscriber, failed: Subscriber[]): void {
    this.safeSend(subscriber, { type: "missed", cursor: subscriber.delivered });
    failed.push(subscriber);
  }

  private safeSend(subscriber: Subscriber, frame: BoardSocketFrame): boolean {
    try {
      subscriber.send(frame);
      return true;
    } catch (error: unknown) {
      console.warn("[message-board] event send failed:", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }

  private remove(id: number): void {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return;
    this.subscribers.delete(id);
    try {
      subscriber.close();
    } catch (error: unknown) {
      console.warn("[message-board] subscriber close failed:", error instanceof Error ? error.name : "UnknownError");
    }
    if (this.subscribers.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private evictStale(): void {
    const cutoff = this.now() - this.options.staleMs;
    for (const subscriber of [...this.subscribers.values()]) {
      if (subscriber.lastTouched < cutoff) this.remove(subscriber.id);
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat || this.options.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => this.tick(), this.options.heartbeatMs);
    this.heartbeat.unref?.();
  }
}

function boardKey(ownerId: string, boardName: string): string {
  return `${ownerId}\u0000${boardName.toLowerCase()}`;
}

function previousCursor(cursor: string): string {
  return String(BigInt(cursor) - 1n);
}
