import type { PlatformDB } from '../db.js';
import { COMPUTE_HOLDING_STATUSES, countRunningContainers, lockCapacity } from '../free-tier/capacity.js';
import {
  closeComputeInterval, computeIntervalEnd, decideComputeStart, readComputeUsage, recordExportWake,
  type ComputeCapConfig, type ComputeMode,
} from '../free-tier/compute-meter.js';

/**
 * The lifecycle writes that open and close metered compute (spec 2691, D3).
 * A claim opens the interval (`metered_since`) and a write that ends compute
 * clears it, each under the row lock in the transaction that changes status,
 * so an interval is closed exactly once however stops and reconciles race.
 * A stop that could not confirm its unit suspended keeps the interval open,
 * bounded by `compute_unconfirmed_until`, when the unit's lifetime has
 * certainly ended it; the next claim or destroy closes it there.
 */

type Executor = PlatformDB['executor'];

export type ClaimOutcome = boolean | 'busy' | { limitResetsAt: string };

export function holdsCompute(status: unknown): boolean {
  return (COMPUTE_HOLDING_STATUSES as readonly unknown[]).includes(status);
}

export function createComputeMetering(deps: {
  db: PlatformDB;
  now: () => Date;
  maxRunning?: number;
  computeCap?: ComputeCapConfig;
}) {
  const { db, now } = deps;

  /**
   * Runs a write that ends compute and closes the interval it ends; the write must clear `metered_since`.
   * With `keepOpen`, a row whose earlier unit is still unconfirmed (`compute_unconfirmed_until` ahead)
   * runs that write instead and keeps metering: the unit may still run until its fate is confirmed.
   */
  async function closing(
    machineId: string,
    write: (executor: Executor) => Promise<boolean>,
    keepOpen?: (executor: Executor) => Promise<boolean>,
  ): Promise<boolean> {
    return db.transaction(async (trx) => {
      const locked = await trx.executor.selectFrom('user_machines')
        .select(['clerk_user_id', 'metered_since', 'compute_mode', 'compute_unconfirmed_until', 'started_at', 'unit_expires_at'])
        .where('machine_id', '=', machineId).where('substrate', '=', 'container')
        .forUpdate().executeTakeFirst();
      if (!locked) return false;
      if (keepOpen && locked.compute_unconfirmed_until && locked.compute_unconfirmed_until.getTime() > now().getTime()) {
        return keepOpen(trx.executor);
      }
      const written = await write(trx.executor);
      if (written && locked.metered_since) {
        await closeComputeInterval(trx.executor, {
          clerkUserId: locked.clerk_user_id,
          mode: locked.compute_mode === 'export_only' ? 'export_only' : 'full',
          openedAt: locked.metered_since,
          closedAt: computeIntervalEnd(now(), locked),
        });
      }
      return written;
    });
  }

  /**
   * The running ceiling is counted and the claim made under one capacity
   * lock, so concurrent starts cannot pass it. The owner's compute cap is
   * read under the row lock, and the claim opens the metered interval.
   */
  async function claimStart(machineId: string, from: string, generation: number, exportIntent: boolean): Promise<ClaimOutcome> {
    return db.transaction(async (trx): Promise<ClaimOutcome> => {
      if (deps.maxRunning !== undefined) await lockCapacity(trx.executor, 'running_runtimes');
      const row = await trx.executor.selectFrom('user_machines')
        .select(['clerk_user_id', 'status', 'generation', 'metered_since', 'compute_mode', 'compute_unconfirmed_until', 'started_at', 'unit_expires_at'])
        .where('machine_id', '=', machineId).where('substrate', '=', 'container').where('deleted_at', 'is', null)
        .forUpdate().executeTakeFirst();
      if (!row || row.status !== from || row.generation !== generation) return false;
      const at = now();
      let mode: ComputeMode = 'full';
      if (deps.computeCap) {
        const decision = decideComputeStart(await readComputeUsage(trx.executor, row.clerk_user_id, at), deps.computeCap, at, exportIntent);
        if (decision.kind === 'limit_reached') return { limitResetsAt: decision.resetsAt };
        mode = decision.kind;
      }
      // A failed stop's unconfirmed unit already holds its slot, so its recovery needs no other.
      // Kept through failed recovery attempts until the unit's fate is confirmed.
      const holdsSlot = row.compute_unconfirmed_until !== null && row.compute_unconfirmed_until.getTime() > at.getTime();
      if (deps.maxRunning !== undefined
        && await countRunningContainers(trx.executor, at) - (holdsSlot ? 1 : 0) >= deps.maxRunning) return 'busy';
      const updated = await trx.executor.updateTable('user_machines')
        .set({
          status: 'starting', started_at: at, failure_code: null, failure_at: null, status_changed_at: at,
          // The unit serving this claim records its expiry once it is resumed or created.
          metered_since: at, compute_mode: mode, unit_expires_at: null,
        })
        .where('machine_id', '=', machineId).where('substrate', '=', 'container').where('deleted_at', 'is', null)
        .where('status', '=', from).where('generation', '=', generation)
        .returning('machine_id').executeTakeFirst();
      // An export-only wake is spent when claimed, so a failed start cannot be retried for free.
      // An interval a failed stop left open ends where this claim starts, or where its unit's lifetime did.
      if (updated && row.metered_since) {
        await closeComputeInterval(trx.executor, {
          clerkUserId: row.clerk_user_id,
          mode: row.compute_mode === 'export_only' ? 'export_only' : 'full',
          openedAt: row.metered_since,
          closedAt: computeIntervalEnd(at, row),
        });
      }
      if (updated && mode === 'export_only') await recordExportWake(trx.executor, row.clerk_user_id, at);
      return Boolean(updated);
    });
  }

  return { closing, claimStart };
}
