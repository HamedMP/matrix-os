/**
 * Off-call-path usage writer and hourly maintenance for Matrix Core MCP.
 * `record()` never throws, never awaits, and never blocks a broker call: a
 * full queue drops the row and counts it. Shutdown drains what is queued.
 */
import {
  MCP_USAGE_ENTRY_POINTS,
  MCP_USAGE_OUTCOMES,
  type McpUsageEventRow,
  type McpUsageRepository,
} from "./database.js";

export const MCP_USAGE_QUEUE_CAPACITY = 10_000;
export const MCP_USAGE_FLUSH_INTERVAL_MS = 5_000;
export const MCP_USAGE_BATCH_SIZE = 500;
export const MCP_USAGE_MAINTENANCE_INTERVAL_MS = 60 * 60_000;

const ENTRY_POINTS = new Set<string>(MCP_USAGE_ENTRY_POINTS);
const OUTCOMES = new Set<string>(MCP_USAGE_OUTCOMES);

export interface McpUsageWriterStats { queued: number; written: number; dropped: number; failed: number }

function validRow(row: McpUsageEventRow): boolean {
  return row.occurredAt instanceof Date && Number.isFinite(row.occurredAt.getTime())
    && (row.orgId === null || (typeof row.orgId === "string" && row.orgId.length <= 128))
    && typeof row.actorId === "string" && row.actorId.length >= 1 && row.actorId.length <= 256
    && typeof row.connectionId === "string" && row.connectionId.length >= 1 && row.connectionId.length <= 64
    && typeof row.serverKey === "string" && row.serverKey.length >= 1 && row.serverKey.length <= 128
    && typeof row.toolName === "string" && row.toolName.length >= 1 && row.toolName.length <= 128
    && ENTRY_POINTS.has(row.entryPoint) && OUTCOMES.has(row.outcome)
    && (row.harness === null || (typeof row.harness === "string" && row.harness.length <= 32))
    && Number.isSafeInteger(row.latencyMs) && row.latencyMs >= 0 && row.latencyMs <= 2_147_483_647;
}

export function createMcpUsageWriter(options: {
  insert(rows: readonly McpUsageEventRow[]): Promise<void>;
  capacity?: number;
  batchSize?: number;
  flushIntervalMs?: number;
}) {
  const capacity = options.capacity ?? MCP_USAGE_QUEUE_CAPACITY;
  const batchSize = options.batchSize ?? MCP_USAGE_BATCH_SIZE;
  const queue: McpUsageEventRow[] = [];
  const stats = { written: 0, dropped: 0, failed: 0 };
  let reportedDrops = 0;
  let flushing: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  async function flushAll(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.splice(0, batchSize);
      try {
        await options.insert(batch);
        stats.written += batch.length;
      } catch (error: unknown) {
        // Usage is best-effort telemetry; a failing batch is counted, never retried forever.
        stats.failed += batch.length;
        console.error("[mcp-usage] batch insert failed", { rows: batch.length, error: error instanceof Error ? error.message : "UnknownError" });
      }
    }
    if (stats.dropped > reportedDrops) {
      console.warn("[mcp-usage] usage rows dropped at queue capacity", { dropped: stats.dropped - reportedDrops });
      reportedDrops = stats.dropped;
    }
  }

  function flush(): Promise<void> {
    flushing ??= flushAll().finally(() => { flushing = undefined; });
    return flushing;
  }

  return {
    record(row: McpUsageEventRow): void {
      try {
        if (closed || queue.length >= capacity || !validRow(row)) { stats.dropped++; return; }
        queue.push(row);
      } catch (error: unknown) {
        stats.dropped++;
        console.warn("[mcp-usage] usage row rejected", error instanceof Error ? error.name : "UnknownError");
      }
    },
    flush,
    start(): void {
      if (timer || closed) return;
      timer = setInterval(() => { void flush(); }, options.flushIntervalMs ?? MCP_USAGE_FLUSH_INTERVAL_MS);
      timer.unref();
    },
    /** Stop accepting rows, then write everything already queued (and any in-flight batch). */
    async drain(): Promise<void> {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (flushing) await flushing;
      await flush();
    },
    stats(): McpUsageWriterStats { return { queued: queue.length, ...stats }; },
  };
}

export type McpUsageWriter = ReturnType<typeof createMcpUsageWriter>;

/** Hourly rollup then retention; runs never overlap and stop() awaits an in-flight run. */
export function startMcpUsageMaintenance(options: { repository: McpUsageRepository; intervalMs?: number }) {
  let running: Promise<void> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped || running) return running;
    running = (async () => {
      try {
        // Catch up fully (bounded) before retention may delete any raw row.
        for (let step = 0; step < 10; step++) {
          if ((await options.repository.rollupDaily()).caughtUp) break;
        }
        await options.repository.sweepRetention();
      } catch (error: unknown) {
        console.error("[mcp-usage] maintenance failed", error instanceof Error ? error.message : "UnknownError");
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  const timer = setInterval(() => { void run(); }, options.intervalMs ?? MCP_USAGE_MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return {
    run,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (running) await running;
    },
  };
}
