import { sql, type ColumnType } from 'kysely';
import type { PlatformDB } from '../db.js';
import { CONTAINER_UNIT_MAX_LIFETIME_SECONDS } from '../substrates/container-provider.js';

/**
 * Billed compute per free owner per UTC calendar month (spec 2691, D3). The
 * platform meters its own lifecycle transitions, never provider billing: an
 * interval opens when a start is claimed and closes in the transaction of the
 * transition that ends compute (suspend, failure, loss, or destroy), idle
 * tail included. A unit still holding compute counts at read time.
 */

export interface RuntimeComputeUsageTable {
  clerk_user_id: string;
  month_start: ColumnType<string, string, string>;
  billed_ms: ColumnType<number | string, number | undefined, number>;
  export_ms: ColumnType<number | string, number | undefined, number>;
  export_wakes: ColumnType<number, number | undefined, number>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type ComputeMode = 'full' | 'export_only';

export interface ComputeCapConfig {
  capMs: number;
  exportWakesPerMonth: number;
  /** An export-only unit is stopped once it has held compute this long. */
  exportWindowMs: number;
}

export const DEFAULT_COMPUTE_CAP_CONFIG: ComputeCapConfig = {
  capMs: 80 * 3_600_000,
  exportWakesPerMonth: 2,
  exportWindowMs: 15 * 60_000,
};

export interface ComputeUsage {
  billedMs: number;
  exportMs: number;
  exportWakes: number;
}

type Executor = PlatformDB['executor'];

export function monthStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export function nextMonthStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

export function monthKey(monthStart: Date): string {
  return monthStart.toISOString().slice(0, 10);
}

/**
 * Where an open interval ends: now, or earlier once the unit's provider
 * lifetime (from the start that opened it) or a failed stop's bound has
 * certainly ended its compute, however late the platform notices.
 */
export function computeIntervalEnd(at: Date, row: { started_at: Date | null; compute_unconfirmed_until: Date | null }): Date {
  let end = at.getTime();
  if (row.started_at) end = Math.min(end, row.started_at.getTime() + CONTAINER_UNIT_MAX_LIFETIME_SECONDS * 1000);
  if (row.compute_unconfirmed_until) end = Math.min(end, row.compute_unconfirmed_until.getTime());
  return new Date(end);
}

/** Owner-month rows hold closed time; open intervals on the owner's container rows are added here. */
export async function readComputeUsage(executor: Executor, clerkUserId: string, at: Date): Promise<ComputeUsage> {
  const monthStart = monthStartUtc(at);
  const closed = await executor.selectFrom('runtime_compute_usage')
    .select(['billed_ms', 'export_ms', 'export_wakes'])
    .where('clerk_user_id', '=', clerkUserId).where('month_start', '=', monthKey(monthStart))
    .executeTakeFirst();
  const usage: ComputeUsage = {
    billedMs: Number(closed?.billed_ms ?? 0),
    exportMs: Number(closed?.export_ms ?? 0),
    exportWakes: closed?.export_wakes ?? 0,
  };
  const open = await executor.selectFrom('user_machines')
    .select(['metered_since', 'compute_mode', 'compute_unconfirmed_until', 'started_at'])
    .where('clerk_user_id', '=', clerkUserId).where('substrate', '=', 'container')
    .where('deleted_at', 'is', null).where('metered_since', 'is not', null)
    .execute();
  for (const row of open) {
    if (!row.metered_since) continue;
    const since = Math.max(row.metered_since.getTime(), monthStart.getTime());
    const end = computeIntervalEnd(at, row).getTime();
    const elapsed = Math.max(0, end - since);
    if (row.compute_mode === 'export_only') usage.exportMs += elapsed;
    else usage.billedMs += elapsed;
  }
  return usage;
}

/** Adds a closed interval to each UTC month it spans. Call inside the transition's transaction. */
export async function closeComputeInterval(executor: Executor, interval: {
  clerkUserId: string;
  mode: ComputeMode;
  openedAt: Date;
  closedAt: Date;
}): Promise<void> {
  let cursor = interval.openedAt;
  while (cursor.getTime() < interval.closedAt.getTime()) {
    const boundary = nextMonthStartUtc(cursor);
    const end = boundary.getTime() < interval.closedAt.getTime() ? boundary : interval.closedAt;
    const ms = end.getTime() - cursor.getTime();
    const billed = interval.mode === 'full' ? ms : 0;
    const exported = interval.mode === 'export_only' ? ms : 0;
    await sql`
      INSERT INTO runtime_compute_usage (clerk_user_id, month_start, billed_ms, export_ms)
      VALUES (${interval.clerkUserId}, ${monthKey(monthStartUtc(cursor))}, ${billed}, ${exported})
      ON CONFLICT (clerk_user_id, month_start) DO UPDATE SET
        billed_ms = runtime_compute_usage.billed_ms + EXCLUDED.billed_ms,
        export_ms = runtime_compute_usage.export_ms + EXCLUDED.export_ms,
        updated_at = now()
    `.execute(executor);
    cursor = end;
  }
}

export async function recordExportWake(executor: Executor, clerkUserId: string, at: Date): Promise<void> {
  await sql`
    INSERT INTO runtime_compute_usage (clerk_user_id, month_start, export_wakes)
    VALUES (${clerkUserId}, ${monthKey(monthStartUtc(at))}, 1)
    ON CONFLICT (clerk_user_id, month_start) DO UPDATE SET
      export_wakes = runtime_compute_usage.export_wakes + 1, updated_at = now()
  `.execute(executor);
}

export type ComputeStartDecision =
  | { kind: 'full' }
  | { kind: 'export_only' }
  | { kind: 'limit_reached'; resetsAt: string };

/** At or over the cap, only an export intent with a wake left may start, and only in export-only mode. */
export function decideComputeStart(usage: ComputeUsage, config: ComputeCapConfig, at: Date, exportIntent: boolean): ComputeStartDecision {
  if (usage.billedMs < config.capMs) return { kind: 'full' };
  if (exportIntent && usage.exportWakes < config.exportWakesPerMonth) return { kind: 'export_only' };
  return { kind: 'limit_reached', resetsAt: nextMonthStartUtc(at).toISOString() };
}
