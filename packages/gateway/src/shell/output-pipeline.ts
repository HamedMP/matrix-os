import type { ScrollbackRecord } from "./scrollback-store.js";

interface PendingStore {
  append(name: string, records: ScrollbackRecord[]): Promise<void>;
}

export interface PendingPersistQueueOptions {
  store: PendingStore;
  sessionName: string;
  flushIntervalMs?: number;
  flushBytes?: number;
  maxPendingBytes?: number;
  maxBackoffMs?: number;
}

interface PendingEntry {
  record: ScrollbackRecord;
  bytes: number;
}

function recordBytes(record: ScrollbackRecord): number {
  return record.type === "output" ? Buffer.byteLength(record.data) + 16 : 32;
}

/**
 * Coalesces terminal scrollback appends so live output delivery never waits on
 * disk. Bounded: when the pending queue exceeds its byte cap, the oldest
 * records are dropped from persistence only (live delivery already happened)
 * and the dropped range is exposed via evictedThroughSeq so replay can report
 * the gap. Store failures retry with capped backoff and never propagate.
 */
export class PendingPersistQueue {
  private readonly store: PendingStore;
  private readonly sessionName: string;
  private readonly flushIntervalMs: number;
  private readonly flushBytes: number;
  private readonly maxPendingBytes: number;
  private readonly maxBackoffMs: number;

  private pending: PendingEntry[] = [];
  private bytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private backoffMs = 0;
  private lastDropWarnAt = 0;
  private disposed = false;

  evictedThroughSeq: number | null = null;

  constructor(options: PendingPersistQueueOptions) {
    this.store = options.store;
    this.sessionName = options.sessionName;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.flushBytes = options.flushBytes ?? 64 * 1024;
    this.maxPendingBytes = options.maxPendingBytes ?? 4 * 1024 * 1024;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
  }

  get pendingBytes(): number {
    return this.bytes;
  }

  enqueue(records: ScrollbackRecord[]): void {
    if (this.disposed || records.length === 0) {
      return;
    }
    for (const record of records) {
      const size = recordBytes(record);
      this.pending.push({ record, bytes: size });
      this.bytes += size;
    }
    this.evictOverCap();
    if (this.bytes >= this.flushBytes) {
      queueMicrotask(() => {
        void this.flushNow();
      });
      return;
    }
    this.scheduleTimer();
  }

  /** Final drain for shutdown; safe to call repeatedly. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimer();
    await this.flushing;
    await this.flushNow();
  }

  private evictOverCap(): void {
    let droppedThrough: number | null = null;
    while (this.bytes > this.maxPendingBytes && this.pending.length > 1) {
      const dropped = this.pending.shift()!;
      this.bytes -= dropped.bytes;
      droppedThrough = dropped.record.seq;
    }
    if (droppedThrough === null) {
      return;
    }
    this.evictedThroughSeq = Math.max(this.evictedThroughSeq ?? -1, droppedThrough);
    const now = Date.now();
    if (now - this.lastDropWarnAt > 10_000) {
      this.lastDropWarnAt = now;
      console.warn("[shell] persistence queue over cap; dropped oldest pending scrollback:", {
        session: this.sessionName,
        evictedThroughSeq: this.evictedThroughSeq,
      });
    }
  }

  private scheduleTimer(): void {
    if (this.timer || this.disposed) {
      return;
    }
    const delay = this.backoffMs > 0 ? this.backoffMs : this.flushIntervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async flushNow(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
    }
    if (this.pending.length === 0) {
      return;
    }
    const batch = this.pending;
    const batchBytes = this.bytes;
    this.pending = [];
    this.bytes = 0;
    const run = this.store
      .append(this.sessionName, batch.map((entry) => entry.record))
      .then(() => {
        this.backoffMs = 0;
      })
      .catch((err: unknown) => {
        // Requeue in front of anything enqueued during the failed flush, then
        // retry with capped backoff. The byte cap still applies, so a dead
        // store degrades to bounded drop-oldest rather than unbounded growth.
        this.pending = batch.concat(this.pending);
        this.bytes += batchBytes;
        this.evictOverCap();
        this.backoffMs = Math.min(
          this.maxBackoffMs,
          this.backoffMs > 0 ? this.backoffMs * 2 : this.flushIntervalMs * 4,
        );
        console.warn("[shell] scrollback flush failed; will retry:", {
          session: this.sessionName,
          backoffMs: this.backoffMs,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.flushing = null;
        if (this.pending.length > 0 && !this.disposed) {
          this.scheduleTimer();
        }
      });
    this.flushing = run;
    await run;
  }
}
