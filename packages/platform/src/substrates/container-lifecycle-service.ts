import { createHash } from 'node:crypto';
import { sql, type Updateable } from 'kysely';
import type { PlatformDB, UserMachinesTable } from '../db.js';
import { ContainerProviderError, type ContainerProvider, type ContainerUnit } from './container-provider.js';
import type { EnsureRunningResult } from './types.js';

/**
 * Container runtime status machine (data-model.md). Every transition is one
 * UPDATE guarded by (machine_id, status, generation), so concurrent platform
 * instances agree without locks, and no provider call runs inside a
 * transaction. Starts are single-flight: only the instance whose
 * compare-and-set moves the row to `starting` talks to the provider.
 */

export type ContainerStatus =
  | 'provisioning' | 'stopped' | 'starting' | 'running' | 'quiescing'
  | 'failed_start' | 'needs_recovery' | 'migrating';

export type ContainerFailureCode = 'start_timeout' | 'provider_unavailable' | 'busy' | 'quiesce_timeout';

export const CONTAINER_START_TIMEOUT_MS = 90_000;
/** Quiesce (at most 15 min) plus final flush (3 x 120 s), from spec.md, with a minute of margin. */
export const CONTAINER_QUIESCE_TIMEOUT_MS = 22 * 60_000;
const START_RETRY_COOLDOWN_MS = 30_000;
/** Replace rather than resume a unit this close to its provider lifetime. */
const UNIT_EXPIRY_MARGIN_MS = 15 * 60_000;
const PROVIDER_CALL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_LAUNCHES = 32;

export interface ContainerBootContext {
  machineId: string;
  clerkUserId: string;
  handle: string;
  runtimeSlot: string;
  generation: number;
  runtimeTokenEpoch: number;
}

export interface ContainerLifecycleDeps {
  db: PlatformDB;
  provider: ContainerProvider;
  /** Builds the per-unit boot data for a new generation. Runs after the generation bump, before the unit exists. */
  buildBootPayload(context: ContainerBootContext, signal: AbortSignal): Promise<string>;
  now?: () => Date;
  maxConcurrentLaunches?: number;
  logError?: (message: string, detail: Record<string, string | number>) => void;
}

interface MachineRow {
  machine_id: string;
  clerk_user_id: string;
  handle: string;
  runtime_slot: string;
  status: string;
  generation: number;
  runtime_token_epoch: number;
  substrate_ref: string | null;
  started_at: Date | null;
  status_changed_at: Date | null;
  failure_code: string | null;
  failure_at: string | null;
}

/** `unit_pending`: the gateway answered before its unit was recorded; the runtime retries shortly. */
export type RegisterOutcome = 'ok' | 'stale_generation' | 'not_starting' | 'unit_pending';
export type StopOutcome = 'stopped' | 'stale_generation' | 'not_running' | 'needs_recovery';
export type DestroyOutcome = 'destroyed' | 'stale_generation';

function failureCodeFor(error: unknown): ContainerFailureCode {
  if (error instanceof ContainerProviderError
    && (error.code === 'capacity' || error.code === 'quota_exceeded' || error.code === 'throttled')) {
    return 'busy';
  }
  return 'provider_unavailable';
}

function resultForFailure(code: string | null): EnsureRunningResult {
  if (code === 'busy') return { state: 'busy' };
  if (code === 'start_timeout') return { state: 'failed', code: 'start_timeout' };
  return { state: 'failed', code: 'provider_unavailable' };
}

/** Same machine and generation, same key: a retried run returns the unit already created. */
export function containerRunIdempotencyKey(machineId: string, generation: number): string {
  return createHash('sha256').update(`matrix-container-run:v1:${machineId}:${generation}`).digest('hex');
}

export function createContainerLifecycleService(deps: ContainerLifecycleDeps) {
  const { db, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));
  const maxLaunches = deps.maxConcurrentLaunches ?? DEFAULT_MAX_CONCURRENT_LAUNCHES;
  const launches = new Set<Promise<void>>();
  /** Launch slots held by starts whose claim is still in flight, so a burst cannot overshoot the cap. */
  let claiming = 0;
  const shutdownController = new AbortController();

  function callSignal(): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS), shutdownController.signal]);
  }

  async function load(machineId: string): Promise<MachineRow | undefined> {
    return db.executor.selectFrom('user_machines')
      .select(['machine_id', 'clerk_user_id', 'handle', 'runtime_slot', 'status', 'generation',
        'runtime_token_epoch', 'substrate_ref', 'started_at', 'status_changed_at', 'failure_code', 'failure_at'])
      .where('machine_id', '=', machineId)
      .where('substrate', '=', 'container')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }

  async function transition(
    machineId: string,
    from: readonly ContainerStatus[],
    generation: number,
    set: Updateable<UserMachinesTable>,
  ): Promise<boolean> {
    const updated = await db.executor.updateTable('user_machines')
      .set(set.status === undefined ? set : { ...set, status_changed_at: now() })
      .where('machine_id', '=', machineId)
      .where('substrate', '=', 'container')
      .where('deleted_at', 'is', null)
      .where('status', 'in', from)
      .where('generation', '=', generation)
      .returning('machine_id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  async function failStart(machineId: string, generation: number, code: ContainerFailureCode): Promise<void> {
    await transition(machineId, ['starting'], generation, {
      status: 'failed_start', failure_code: code, failure_at: now().toISOString(),
    });
  }

  /**
   * Only a suspended unit is resumed in place: it was running and registered
   * when it was suspended. A unit the provider reports running or pending
   * behind a stopped or failed row never proved a healthy gateway, so it is
   * replaced.
   */
  function resumable(unit: ContainerUnit | null): boolean {
    if (!unit || unit.state !== 'suspended' || !unit.expiresAt) return false;
    return unit.expiresAt.getTime() - now().getTime() > UNIT_EXPIRY_MARGIN_MS;
  }

  async function terminateQuietly(unitId: string, reason: string): Promise<void> {
    try {
      await provider.terminate(unitId, callSignal());
    } catch (error: unknown) {
      logError('[container-lifecycle] terminate failed; left for reconciliation', {
        reason, code: error instanceof ContainerProviderError ? error.code : 'unknown',
      });
    }
  }

  /** Replaces compute: generation and token epoch move together in one statement, fencing the old unit. */
  async function bumpGeneration(machineId: string, generation: number) {
    return db.executor.updateTable('user_machines')
      .set({
        generation: sql<number>`generation + 1`,
        runtime_token_epoch: sql<number>`runtime_token_epoch + 1`,
        substrate_ref: null,
        private_address: null,
      })
      .where('machine_id', '=', machineId)
      .where('substrate', '=', 'container')
      .where('deleted_at', 'is', null)
      .where('status', '=', 'starting')
      .where('generation', '=', generation)
      .returning(['generation', 'runtime_token_epoch'])
      .executeTakeFirst();
  }

  async function launch(row: MachineRow): Promise<void> {
    let generation = row.generation;
    try {
      const previous = row.substrate_ref ? await provider.describe(row.substrate_ref, callSignal()) : null;
      if (previous && resumable(previous)) {
        await provider.resume(previous.unitId, callSignal());
        await transition(row.machine_id, ['starting'], generation, { status: 'running', failure_code: null, failure_at: null });
        return;
      }
      const next = await bumpGeneration(row.machine_id, generation);
      if (!next) return;
      generation = next.generation;
      const bootPayload = await deps.buildBootPayload({
        machineId: row.machine_id,
        clerkUserId: row.clerk_user_id,
        handle: row.handle,
        runtimeSlot: row.runtime_slot,
        generation: next.generation,
        runtimeTokenEpoch: next.runtime_token_epoch,
      }, callSignal());
      const created = await provider.run({
        idempotencyKey: containerRunIdempotencyKey(row.machine_id, next.generation),
        bootPayload,
      }, callSignal());
      if (!created.endpointHost) {
        await terminateQuietly(created.unitId, 'no_endpoint');
        throw new ContainerProviderError('unavailable');
      }
      const recorded = await transition(row.machine_id, ['starting'], next.generation, {
        substrate_ref: created.unitId, private_address: created.endpointHost,
      });
      if (!recorded) await terminateQuietly(created.unitId, 'fenced');
      if (previous && previous.state !== 'terminated') await terminateQuietly(previous.unitId, 'replaced');
    } catch (error: unknown) {
      const code = failureCodeFor(error);
      logError('[container-lifecycle] start failed', {
        code, cause: error instanceof ContainerProviderError ? error.code : 'unknown',
      });
      await failStart(row.machine_id, generation, code);
    }
  }

  function track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      logError('[container-lifecycle] launch bookkeeping failed', { cause: error instanceof Error ? error.name : 'unknown' });
    }).finally(() => { launches.delete(tracked); });
    launches.add(tracked);
  }

  async function ensureStarted(machineId: string): Promise<EnsureRunningResult> {
    const row = await load(machineId);
    if (!row) return { state: 'failed', code: 'needs_recovery' };
    const status = row.status as ContainerStatus;
    switch (status) {
      case 'running':
        return { state: 'running' };
      case 'starting': {
        const startedAt = row.started_at?.getTime() ?? 0;
        if (now().getTime() - startedAt <= CONTAINER_START_TIMEOUT_MS) return { state: 'starting' };
        await failStart(machineId, row.generation, 'start_timeout');
        return { state: 'failed', code: 'start_timeout' };
      }
      case 'provisioning':
        return { state: 'starting' };
      case 'quiescing': {
        const since = row.status_changed_at?.getTime() ?? 0;
        if (now().getTime() - since <= CONTAINER_QUIESCE_TIMEOUT_MS) return { state: 'starting' };
        await transition(machineId, ['quiescing'], row.generation, {
          status: 'needs_recovery', failure_code: 'quiesce_timeout', failure_at: now().toISOString(),
        });
        return { state: 'failed', code: 'needs_recovery' };
      }
      case 'failed_start': {
        const failedAt = row.failure_at ? Date.parse(row.failure_at) : 0;
        if (now().getTime() - failedAt < START_RETRY_COOLDOWN_MS) return resultForFailure(row.failure_code);
        break;
      }
      case 'stopped':
        break;
      default:
        return { state: 'failed', code: 'needs_recovery' };
    }
    if (launches.size + claiming >= maxLaunches || shutdownController.signal.aborted) return { state: 'busy' };
    claiming += 1;
    try {
      const claimed = await transition(machineId, ['stopped', 'failed_start'], row.generation, {
        status: 'starting', started_at: now(), failure_code: null, failure_at: null,
      });
      if (claimed) track(launch({ ...row, status: 'starting' }));
    } finally {
      claiming -= 1;
    }
    return { state: 'starting' };
  }

  /**
   * A runtime is running only once its unit is recorded: registration that
   * beats `launch` saving the unit asks the runtime to retry, so the save
   * still finds the row starting and never fences the new unit.
   */
  async function markRegistered(
    machineId: string,
    generation: number,
    details: { imageVersion?: string } = {},
  ): Promise<RegisterOutcome> {
    const ok = await db.executor.updateTable('user_machines')
      .set({
        status: 'running', last_activity_at: now(),
        ...(details.imageVersion !== undefined ? { image_version: details.imageVersion } : {}),
      })
      .where('machine_id', '=', machineId)
      .where('substrate', '=', 'container')
      .where('deleted_at', 'is', null)
      .where('status', '=', 'starting')
      .where('generation', '=', generation)
      .where('substrate_ref', 'is not', null)
      .returning('machine_id')
      .executeTakeFirst();
    if (ok) return 'ok';
    const row = await load(machineId);
    if (!row || row.generation !== generation) return 'stale_generation';
    if (row.status === 'running') return 'ok';
    return row.status === 'starting' && row.substrate_ref === null ? 'unit_pending' : 'not_starting';
  }

  async function stop(machineId: string, generation: number, signal: AbortSignal): Promise<StopOutcome> {
    const row = await load(machineId);
    if (!row || row.generation !== generation) return 'stale_generation';
    if (row.status === 'stopped') return 'stopped';
    if (!row.substrate_ref || !await transition(machineId, ['running'], generation, { status: 'quiescing' })) {
      return 'not_running';
    }
    try {
      await provider.suspend(row.substrate_ref, AbortSignal.any([signal, callSignal()]));
    } catch (error: unknown) {
      logError('[container-lifecycle] suspend failed', { code: error instanceof ContainerProviderError ? error.code : 'unknown' });
      await transition(machineId, ['quiescing'], generation, {
        status: 'needs_recovery', failure_code: 'provider_unavailable', failure_at: now().toISOString(),
      });
      return 'needs_recovery';
    }
    await transition(machineId, ['quiescing'], generation, { status: 'stopped' });
    return 'stopped';
  }

  async function destroyCompute(machineId: string, generation: number, signal: AbortSignal): Promise<DestroyOutcome> {
    const row = await load(machineId);
    if (!row || row.generation !== generation) return 'stale_generation';
    if (row.substrate_ref) await provider.terminate(row.substrate_ref, AbortSignal.any([signal, callSignal()]));
    await db.executor.updateTable('user_machines')
      .set({
        substrate_ref: null,
        private_address: null,
        status: sql<string>`CASE WHEN status IN ('running', 'starting', 'quiescing') THEN 'stopped' ELSE status END`,
        status_changed_at: now(),
      })
      .where('machine_id', '=', machineId)
      .where('substrate', '=', 'container')
      .where('generation', '=', generation)
      .where(eb => row.substrate_ref === null ? eb('substrate_ref', 'is', null) : eb('substrate_ref', '=', row.substrate_ref))
      .execute();
    return 'destroyed';
  }

  /** The provider ended a running unit (lifetime or loss): the runtime is stopped and the next start runs fresh. */
  async function markComputeLost(machineId: string, generation: number, unitId: string): Promise<boolean> {
    const updated = await db.executor.updateTable('user_machines')
      .set({ status: 'stopped', status_changed_at: now(), substrate_ref: null, private_address: null })
      .where('machine_id', '=', machineId)
      .where('substrate', '=', 'container')
      .where('deleted_at', 'is', null)
      .where('status', '=', 'running')
      .where('generation', '=', generation)
      .where('substrate_ref', '=', unitId)
      .returning('machine_id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  return {
    ensureStarted,
    markComputeLost,
    markRegistered,
    stop,
    destroyCompute,
    /** Resolves when every launch this process started has settled. */
    async drain(): Promise<void> {
      while (launches.size > 0) await Promise.allSettled([...launches]);
    },
    async shutdown(): Promise<void> {
      shutdownController.abort();
      while (launches.size > 0) await Promise.allSettled([...launches]);
    },
  };
}

export type ContainerLifecycleService = ReturnType<typeof createContainerLifecycleService>;
