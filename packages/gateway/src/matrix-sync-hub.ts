import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  MatrixClient,
  MatrixRawEvent,
  MatrixSyncResponse,
} from './matrix-client.js';
import { resolveWithinHome } from './path-security.js';

/**
 * MatrixSyncHub — single account-wide `/sync` long-poll owner.
 *
 * There is exactly ONE MatrixSyncHub instance per gateway process. It owns
 * the only `/sync` cursor for the account, fans events out to registered
 * handlers, and enforces the four-point ordering contract from spec §E.1.
 *
 * Ordering contract (asserted by tests — do not weaken):
 *   1. Room handlers are SERIAL per room: events from the same `(roomId, *)`
 *      are delivered in `/sync` order, never concurrently.
 *   2. DIFFERENT rooms dispatch IN PARALLEL: room A and room B each have
 *      their own chained-promise queue.
 *   3. Global handlers (presence, account_data) dispatch serially on a
 *      SINGLE global queue distinct from per-room queues.
 *   4. There is NO total-ordering guarantee between global and room-scoped
 *      handlers from the same `/sync` batch. Presence and timeline events
 *      from the same batch may dispatch in either order. This is the
 *      intentional v1 tradeoff (presence is independent of shared state);
 *      any future feature that needs cross-stream ordering must use a
 *      different abstraction.
 *
 * Gap-fill contract (NON-NEGOTIABLE, spec §E.1 / spike §9.1):
 *
 * Conduit (and, by extension, any Matrix homeserver under bursty-write
 * load) can return a `/sync` batch that silently omits events committed
 * between the previous and current `next_batch` without `limited: true`.
 * The hub MUST detect this and backfill via `/messages?dir=b` BEFORE
 * delivering subsequent events to registered handlers.
 *
 *  - per-room recency ring (cap 256 events, LRU) tracks
 *    `(event_id, origin_server_ts, lamport)` for every inbound event
 *  - `reportGap(roomId, expectedLamport)` is a callback API the app layer
 *    (GroupSync/CRDT) uses when it observes a non-monotonic lamport for a
 *    single client_id within a batch
 *  - `timeline.limited === true` OR a reported gap pauses room-scoped
 *    dispatch for that room while backfill runs
 *  - backfill hits `/_matrix/client/v3/rooms/{roomId}/messages?dir=b&
 *    from=<prev_batch>&limit=500` up to 8 pages, sorts by
 *    `(origin_server_ts, event_id)`, delivers in order, then resumes
 *  - the stored `next_batch` cursor MUST NOT advance past an unresolved
 *    gap; on failure the hub surfaces `sync_failed` to `onError` and
 *    retries on the next /sync iteration
 */

export type SyncHubOnError = (
  code: 'sync_failed',
  detail: Record<string, unknown>,
) => void;

export interface SyncHubOptions {
  client: MatrixClient;
  homePath: string;
  onError?: SyncHubOnError;
  /** Backoff schedule for /sync errors; last entry is the cap. */
  backoffMsSchedule?: number[];
  /** /sync long-poll timeout passed to the server (ms). */
  syncTimeoutMs?: number;
  /** Upper bound of /messages pagination per gap-fill attempt. */
  backfillIterationCap?: number;
  /** Matrix /messages page size. */
  backfillPageLimit?: number;
  /** Per-room recency ring cap. */
  recencyRingCap?: number;
}

export type EventHandler = (event: MatrixRawEvent, roomId: string) => Promise<void> | void;
export type GlobalEventHandler = (event: MatrixRawEvent) => Promise<void> | void;

export interface Disposable {
  dispose(): void;
}

interface RecencyEntry {
  event_id: string;
  origin_server_ts: number;
  lamport: number;
}

interface RoomState {
  /** Queue of pending work to execute serially (chained promise). */
  tail: Promise<void>;
  /** Per-room recency ring; LRU by insertion order, cap = recencyRingCap. */
  ring: RecencyEntry[];
  /** Per-(roomId, eventType) handler registry. */
  handlers: Map<string, Set<EventHandler>>;
  /** The anchor we use as `from=` for backfill. Updated on every /sync. */
  lastPrevBatch: string | null;
  /** Set when we see a gap in this room; cleared when backfill succeeds. */
  pendingGap: boolean;
  /** Maximum lamport seen per client_id (for reportGap detection). */
  maxLamportByClient: Map<string, number>;
}

const DEFAULT_BACKOFF: number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const DEFAULT_BACKFILL_CAP = 8;
const DEFAULT_BACKFILL_LIMIT = 500;
const DEFAULT_RING_CAP = 256;
const CURSOR_FILE = 'system/matrix-sync.json';
const CURSOR_TMP = 'system/matrix-sync.json.tmp';

export class MatrixSyncHub {
  private readonly client: MatrixClient;
  private readonly homePath: string;
  private readonly onError: SyncHubOnError;
  private readonly backoffSchedule: number[];
  private readonly syncTimeoutMs: number;
  private readonly backfillIterationCap: number;
  private readonly backfillPageLimit: number;
  private readonly recencyRingCap: number;
  private readonly rooms = new Map<string, RoomState>();
  private readonly globalHandlers = new Map<string, Set<GlobalEventHandler>>();
  private globalTail: Promise<void> = Promise.resolve();
  private nextBatch: string | null = null;
  private running = false;
  private disposed = false;

  constructor(options: SyncHubOptions) {
    this.client = options.client;
    this.homePath = options.homePath;
    this.onError = options.onError ?? (() => undefined);
    this.backoffSchedule = options.backoffMsSchedule ?? DEFAULT_BACKOFF;
    this.syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.backfillIterationCap = options.backfillIterationCap ?? DEFAULT_BACKFILL_CAP;
    this.backfillPageLimit = options.backfillPageLimit ?? DEFAULT_BACKFILL_LIMIT;
    this.recencyRingCap = options.recencyRingCap ?? DEFAULT_RING_CAP;
    this.nextBatch = this.loadCursorSync();
  }

  // --------------------- handler registration ---------------------

  registerEventHandler(
    roomId: string,
    eventType: string,
    handler: EventHandler,
  ): Disposable {
    const room = this.ensureRoom(roomId);
    let set = room.handlers.get(eventType);
    if (!set) {
      set = new Set();
      room.handlers.set(eventType, set);
    }
    set.add(handler);
    return {
      dispose: () => {
        const current = room.handlers.get(eventType);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) room.handlers.delete(eventType);
      },
    };
  }

  registerGlobalEventHandler(
    eventType: string,
    handler: GlobalEventHandler,
  ): Disposable {
    let set = this.globalHandlers.get(eventType);
    if (!set) {
      set = new Set();
      this.globalHandlers.set(eventType, set);
    }
    set.add(handler);
    return {
      dispose: () => {
        const current = this.globalHandlers.get(eventType);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) this.globalHandlers.delete(eventType);
      },
    };
  }

  getNextBatch(): string {
    return this.nextBatch ?? '';
  }

  /** Test-only window into the recency ring. Do not use in production code. */
  debugGetRoomRing(roomId: string): RecencyEntry[] {
    const room = this.rooms.get(roomId);
    return room ? room.ring.slice() : [];
  }

  /**
   * Application-layer gap signal. Called by GroupSync/CRDT when it sees a
   * non-monotonic lamport for a single client_id within a room. Causes the
   * hub to pause dispatch for the room and run /messages backfill.
   */
  reportGap(roomId: string, expectedLamport: number): void {
    const room = this.ensureRoom(roomId);
    room.pendingGap = true;
    // Execute backfill on the room's tail so it stays serial with dispatch.
    const prev = room.tail;
    room.tail = prev.then(async () => {
      try {
        await this.runBackfill(roomId, { reason: 'report_gap', expectedLamport });
      } catch (err) {
        this.onError('sync_failed', {
          roomId,
          reason: 'backfill_failed',
          error: (err as Error)?.message ?? 'unknown',
        });
      }
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  // --------------------- main loop ---------------------

  async start(signal: AbortSignal): Promise<void> {
    if (this.running) return;
    this.running = true;
    let errorAttempt = 0;

    while (!signal.aborted && !this.disposed) {
      try {
        // Race client.sync() against abort so a long-poll does not trap the
        // loop. On abort the losing promise settles but the loop exits.
        const response = await this.raceAbort(
          this.client.sync({
            since: this.nextBatch ?? undefined,
            timeoutMs: this.syncTimeoutMs,
          }),
          signal,
        );
        errorAttempt = 0;

        if (signal.aborted || this.disposed) break;

        const priorCursor = this.nextBatch;
        await this.processSync(response, priorCursor);

        // Advance cursor iff no room ended the batch with a pending gap.
        if (this.hasPendingGap()) {
          this.onError('sync_failed', {
            reason: 'pending_gap',
            roomCount: this.countPendingGaps(),
          });
          // Do NOT advance nextBatch past the gap — retry on next iteration.
        } else {
          this.nextBatch = response.next_batch;
          await this.persistCursor();
        }
      } catch (err) {
        if (signal.aborted || this.disposed) break;
        const delay = this.backoffSchedule[Math.min(errorAttempt, this.backoffSchedule.length - 1)];
        errorAttempt += 1;
        this.onError('sync_failed', {
          reason: 'sync_error',
          error: (err as Error)?.message ?? 'unknown',
        });
        await this.sleep(delay, signal);
      }
    }

    this.running = false;
  }

  private raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  // --------------------- per-sync processing ---------------------

  private async processSync(
    response: MatrixSyncResponse,
    priorCursor: string | null,
  ): Promise<void> {
    // Global handlers run on the global tail — fire first so presence
    // doesn't block on heavy room dispatch (but still serial-within-stream).
    const presenceEvents = response.presence?.events ?? [];
    const accountDataEvents = response.account_data?.events ?? [];
    for (const ev of presenceEvents) {
      this.dispatchGlobal(ev);
    }
    for (const ev of accountDataEvents) {
      this.dispatchGlobal(ev);
    }

    // Room-scoped dispatch: per room, chain work on the room's tail.
    const joins = response.rooms?.join ?? {};
    for (const [roomId, joined] of Object.entries(joins)) {
      const timeline = joined.timeline?.events ?? [];
      const stateEvents = joined.state?.events ?? [];
      const limited = Boolean(joined.timeline?.limited);
      const prevBatch = joined.timeline?.prev_batch ?? priorCursor ?? null;
      this.scheduleRoomBatch(roomId, {
        timeline,
        stateEvents,
        limited,
        prevBatch,
      });
    }

    // Wait for all room tails to complete so processSync returns in the same
    // order as /sync batches. This enforces batch-granularity serialization
    // while preserving per-room parallelism across batches.
    const tails: Array<Promise<void>> = [];
    for (const [, room] of this.rooms) {
      tails.push(room.tail.catch(() => undefined));
    }
    tails.push(this.globalTail.catch(() => undefined));
    await Promise.all(tails);
  }

  private scheduleRoomBatch(
    roomId: string,
    batch: {
      timeline: MatrixRawEvent[];
      stateEvents: MatrixRawEvent[];
      limited: boolean;
      prevBatch: string | null;
    },
  ): void {
    const room = this.ensureRoom(roomId);
    room.lastPrevBatch = batch.prevBatch;

    const prevTail = room.tail;
    room.tail = prevTail.then(async () => {
      try {
        // Dispatch room state events first — they change ACL, snapshots, etc.
        for (const ev of batch.stateEvents) {
          this.updateRecency(room, ev);
          await this.fireRoomHandlers(roomId, ev);
        }

        // If limited=true, run backfill BEFORE delivering the new timeline slice.
        if (batch.limited) {
          room.pendingGap = true;
          await this.runBackfill(roomId, { reason: 'limited' });
        }

        // Now deliver the timeline slice, in order. For each event, update
        // recency + fire handlers. If an event advances the lamport for its
        // client_id by more than 1, treat it as a gap signal and backfill.
        // Events already delivered via backfill (found in the ring) are
        // skipped here — at-least-once becomes exactly-once through the ring.
        for (const ev of batch.timeline) {
          if (ev.event_id && room.ring.some((r) => r.event_id === ev.event_id)) {
            continue;
          }
          const gapDetected = this.detectGapFromEvent(room, ev);
          if (gapDetected && !room.pendingGap) {
            room.pendingGap = true;
            await this.runBackfill(roomId, { reason: 'lamport_gap', expectedLamport: gapDetected });
            if (ev.event_id && room.ring.some((r) => r.event_id === ev.event_id)) {
              continue;
            }
          }
          this.updateRecency(room, ev);
          await this.fireRoomHandlers(roomId, ev);
        }
      } catch (err) {
        this.onError('sync_failed', {
          roomId,
          reason: 'dispatch_failed',
          error: (err as Error)?.message ?? 'unknown',
        });
      }
    });
  }

  private async fireRoomHandlers(
    roomId: string,
    event: MatrixRawEvent,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const set = room.handlers.get(event.type);
    if (!set || set.size === 0) return;
    for (const handler of Array.from(set)) {
      await handler(event, roomId);
    }
  }

  private dispatchGlobal(event: MatrixRawEvent): void {
    const handlers = this.globalHandlers.get(event.type);
    if (!handlers || handlers.size === 0) return;
    const snapshot = Array.from(handlers);
    const prev = this.globalTail;
    this.globalTail = prev.then(async () => {
      for (const handler of snapshot) {
        try {
          await handler(event);
        } catch (err) {
          this.onError('sync_failed', {
            reason: 'global_handler_failed',
            eventType: event.type,
            error: (err as Error)?.message ?? 'unknown',
          });
        }
      }
    });
  }

  // --------------------- gap-fill ---------------------

  private detectGapFromEvent(
    room: RoomState,
    event: MatrixRawEvent,
  ): number | null {
    const content = event.content as { lamport?: unknown; client_id?: unknown } | undefined;
    if (!content) return null;
    const lamport = typeof content.lamport === 'number' ? content.lamport : null;
    const clientId = typeof content.client_id === 'string' ? content.client_id : null;
    if (lamport === null || clientId === null) return null;

    const prev = room.maxLamportByClient.get(clientId);
    if (prev !== undefined && lamport > prev + 1) {
      room.maxLamportByClient.set(clientId, lamport);
      return lamport;
    }
    if (prev === undefined || lamport > prev) {
      room.maxLamportByClient.set(clientId, lamport);
    }
    return null;
  }

  private async runBackfill(
    roomId: string,
    cause: { reason: string; expectedLamport?: number },
  ): Promise<void> {
    const room = this.ensureRoom(roomId);
    let from = room.lastPrevBatch;
    let pages = 0;
    const seenIds = new Set(room.ring.map((r) => r.event_id));
    const collected: MatrixRawEvent[] = [];

    while (pages < this.backfillIterationCap) {
      pages += 1;
      let page: { chunk: MatrixRawEvent[]; end: string };
      try {
        page = await this.client.getRoomMessages(roomId, {
          dir: 'b',
          from: from ?? undefined,
          limit: this.backfillPageLimit,
        });
      } catch (err) {
        this.onError('sync_failed', {
          roomId,
          reason: 'backfill_failed',
          cause: cause.reason,
          error: (err as Error)?.message ?? 'unknown',
        });
        // Room stays pendingGap; cursor will not advance.
        return;
      }

      let anchorHit = false;
      for (const ev of page.chunk) {
        if (ev.event_id && seenIds.has(ev.event_id)) {
          anchorHit = true;
          continue;
        }
        collected.push(ev);
      }
      if (anchorHit || page.chunk.length === 0) {
        break;
      }
      from = page.end;
    }

    if (pages >= this.backfillIterationCap && collected.length === 0) {
      // nothing actionable from the cap hit with no anchor hit
      this.onError('sync_failed', {
        roomId,
        reason: 'backfill_iteration_cap',
        pages,
      });
      return;
    }

    // Sort by (origin_server_ts, event_id) ascending, then dispatch new events
    // in order. Events already in the recency ring are skipped.
    collected.sort((a, b) => {
      const tsDiff = (a.origin_server_ts ?? 0) - (b.origin_server_ts ?? 0);
      if (tsDiff !== 0) return tsDiff;
      return (a.event_id ?? '').localeCompare(b.event_id ?? '');
    });

    for (const ev of collected) {
      this.updateRecency(room, ev);
      await this.fireRoomHandlers(roomId, ev);
    }

    if (pages >= this.backfillIterationCap) {
      // Iteration cap reached, but we still delivered some events. Still flag
      // the cap so callers notice over-long gaps.
      this.onError('sync_failed', {
        roomId,
        reason: 'backfill_iteration_cap',
        pages,
      });
      return;
    }

    room.pendingGap = false;
  }

  // --------------------- recency ring ---------------------

  private updateRecency(room: RoomState, ev: MatrixRawEvent): void {
    const entry: RecencyEntry = {
      event_id: ev.event_id ?? '',
      origin_server_ts: ev.origin_server_ts ?? 0,
      lamport: readLamport(ev),
    };
    // Remove any prior occurrence — keep the ring unique-ish.
    const priorIdx = room.ring.findIndex((r) => r.event_id === entry.event_id);
    if (priorIdx >= 0) {
      room.ring.splice(priorIdx, 1);
    }
    room.ring.push(entry);
    while (room.ring.length > this.recencyRingCap) {
      room.ring.shift();
    }
  }

  // --------------------- cursor persistence ---------------------

  private loadCursorSync(): string | null {
    const target = resolveWithinHome(this.homePath, CURSOR_FILE);
    if (!target) return null;
    try {
      // Constructor is sync and the file is a tiny JSON; this is a
      // one-shot startup read, never in a request handler path.
      const raw = readFileSync(target, 'utf8');
      const parsed = JSON.parse(raw) as { next_batch?: unknown };
      const nb = parsed.next_batch;
      return typeof nb === 'string' && nb.length > 0 ? nb : null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      // Corrupt file — log via onError and return null to start cold.
      this.onError('sync_failed', {
        reason: 'corrupt_cursor',
        error: (err as Error)?.message ?? 'unknown',
      });
      return null;
    }
  }

  private async persistCursor(): Promise<void> {
    if (!this.nextBatch) return;
    const target = resolveWithinHome(this.homePath, CURSOR_FILE);
    const tmp = resolveWithinHome(this.homePath, CURSOR_TMP);
    if (!target || !tmp) return;
    try {
      await fs.mkdir(join(this.homePath, 'system'), { recursive: true });
      const json = JSON.stringify({ next_batch: this.nextBatch });
      await fs.writeFile(tmp, json, { encoding: 'utf8', flag: 'w' });
      await fs.rename(tmp, target);
    } catch (err) {
      this.onError('sync_failed', {
        reason: 'persist_cursor_failed',
        error: (err as Error)?.message ?? 'unknown',
      });
    }
  }

  // --------------------- utilities ---------------------

  private ensureRoom(roomId: string): RoomState {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        tail: Promise.resolve(),
        ring: [],
        handlers: new Map(),
        lastPrevBatch: null,
        pendingGap: false,
        maxLamportByClient: new Map(),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private hasPendingGap(): boolean {
    for (const [, room] of this.rooms) {
      if (room.pendingGap) return true;
    }
    return false;
  }

  private countPendingGaps(): number {
    let n = 0;
    for (const [, room] of this.rooms) {
      if (room.pendingGap) n += 1;
    }
    return n;
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function readLamport(ev: MatrixRawEvent): number {
  const content = ev.content as { lamport?: unknown } | undefined;
  if (content && typeof content.lamport === 'number') return content.lamport;
  return 0;
}
