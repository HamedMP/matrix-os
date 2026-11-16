import type { PlatformDB } from '../db.js';
import { ContainerProviderError, type ContainerProvider, type ContainerUnit } from './container-provider.js';

/**
 * Deletes container compute that no live runtime record references (spec
 * 2691, "Orphan sweep"): units of replaced generations, of deleted runtimes,
 * or left by a platform crash between creating a unit and recording it. It
 * only ever terminates compute; owner databases and object prefixes are not
 * reachable from here.
 *
 * A start records its unit within seconds of creating it (every step is
 * bounded by provider and boot timeouts), so a unit younger than the grace
 * period may belong to a start in flight and is left alone. Units whose age
 * the provider does not report must stay unreferenced for the whole grace
 * period across sweeps.
 */

export interface OrphanReconcilerConfig {
  intervalMs: number;
  graceMs: number;
  maxTerminationsPerSweep: number;
  /** Units whose age is unknown, remembered by first sighting. */
  maxTracked: number;
}

export const DEFAULT_ORPHAN_RECONCILER_CONFIG: OrphanReconcilerConfig = {
  intervalMs: 5 * 60_000,
  graceMs: 10 * 60_000,
  maxTerminationsPerSweep: 25,
  maxTracked: 5_000,
};

const LIST_TIMEOUT_MS = 30_000;
const TERMINATE_TIMEOUT_MS = 10_000;
const LOOKUP_CHUNK = 200;

export interface OrphanReconcilerDeps {
  db: PlatformDB;
  provider: Pick<ContainerProvider, 'list' | 'terminate'>;
  config?: Partial<OrphanReconcilerConfig>;
  now?: () => Date;
  logError?: (message: string, detail: Record<string, string | number>) => void;
  log?: (message: string, detail: Record<string, string | number>) => void;
}

function errorCode(error: unknown): string {
  if (error instanceof ContainerProviderError) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

export function createOrphanReconciler(deps: OrphanReconcilerDeps) {
  const { db, provider } = deps;
  const config: OrphanReconcilerConfig = { ...DEFAULT_ORPHAN_RECONCILER_CONFIG, ...deps.config };
  const now = deps.now ?? (() => new Date());
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));
  const log = deps.log ?? ((message, detail) => console.warn(message, detail));
  const shutdownController = new AbortController();
  /** First sighting of unreferenced units with no reported creation time. */
  const firstSeen = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweeping: Promise<{ terminated: number }> | null = null;

  async function referenced(unitIds: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let index = 0; index < unitIds.length; index += LOOKUP_CHUNK) {
      const rows = await db.executor.selectFrom('user_machines')
        .select('substrate_ref')
        .where('substrate', '=', 'container')
        .where('deleted_at', 'is', null)
        .where('substrate_ref', 'in', unitIds.slice(index, index + LOOKUP_CHUNK))
        .execute();
      for (const row of rows) if (row.substrate_ref) found.add(row.substrate_ref);
    }
    return found;
  }

  function oldEnough(unit: ContainerUnit, at: number): boolean {
    if (unit.createdAt) return at - unit.createdAt.getTime() >= config.graceMs;
    const seen = firstSeen.get(unit.unitId);
    if (seen === undefined) {
      if (firstSeen.size >= config.maxTracked) return false;
      firstSeen.set(unit.unitId, at);
      return false;
    }
    return at - seen >= config.graceMs;
  }

  async function runSweep(): Promise<{ terminated: number }> {
    const signal = shutdownController.signal;
    let units: ContainerUnit[];
    try {
      units = await provider.list(AbortSignal.any([signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]));
    } catch (error: unknown) {
      logError('[orphan-reconciler] provider list failed', { code: errorCode(error) });
      return { terminated: 0 };
    }
    const live = units.filter(unit => unit.state !== 'terminated' && unit.state !== 'terminating');
    const inUse = await referenced(live.map(unit => unit.unitId));
    const orphans = live.filter(unit => !inUse.has(unit.unitId));
    const orphanIds = new Set(orphans.map(unit => unit.unitId));
    for (const unitId of firstSeen.keys()) if (!orphanIds.has(unitId)) firstSeen.delete(unitId);

    const at = now().getTime();
    let terminated = 0;
    for (const unit of orphans) {
      if (terminated >= config.maxTerminationsPerSweep || signal.aborted) break;
      if (!oldEnough(unit, at)) continue;
      try {
        await provider.terminate(unit.unitId, AbortSignal.any([signal, AbortSignal.timeout(TERMINATE_TIMEOUT_MS)]));
        firstSeen.delete(unit.unitId);
        terminated += 1;
      } catch (error: unknown) {
        logError('[orphan-reconciler] terminate failed; retried next sweep', { code: errorCode(error) });
      }
    }
    if (terminated > 0) log('[orphan-reconciler] terminated orphaned compute', { terminated });
    return { terminated };
  }

  return {
    /** One sweep at a time per instance; overlapping calls share it. */
    sweep(): Promise<{ terminated: number }> {
      sweeping ??= runSweep()
        .catch((error: unknown) => {
          logError('[orphan-reconciler] sweep failed', { cause: errorCode(error) });
          return { terminated: 0 };
        })
        .finally(() => { sweeping = null; });
      return sweeping;
    },
    start(): void {
      if (timer || shutdownController.signal.aborted) return;
      timer = setInterval(() => { void this.sweep(); }, config.intervalMs);
      timer.unref?.();
    },
    async shutdown(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      shutdownController.abort();
      await sweeping;
      firstSeen.clear();
    },
  };
}

export type OrphanReconciler = ReturnType<typeof createOrphanReconciler>;
