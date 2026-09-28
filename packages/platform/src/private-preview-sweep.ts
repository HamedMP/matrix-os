import type { CustomerVpsService } from './customer-vps-types.js';
import type { PlatformDB } from './db.js';
import { listActivePrivatePreviews } from './database/private-previews.js';
import { isActiveOrganizationMember, PRIVATE_PREVIEW_TTL_MS } from './private-preview-access.js';

const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH_LIMIT = 200;

export interface PrivatePreviewSweepResult {
  checked: number;
  destroyed: number;
  failed: number;
}

/**
 * Spec 537 P4: destroys Private Previews past their lifetime and those whose
 * owner is no longer an internal member. A membership that cannot be read is
 * not treated as lost, so only expiry applies until the projection answers;
 * personal Integrations stay denied for that machine either way.
 */
export function createPrivatePreviewSweep(opts: {
  db: PlatformDB;
  service: Pick<CustomerVpsService, 'delete'>;
  internalOrganizationId: string | null;
  now?: () => Date;
  minIntervalMs?: number;
  logError?: (context: string, err: unknown) => void;
}): () => Promise<PrivatePreviewSweepResult> {
  const now = opts.now ?? (() => new Date());
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const logError = opts.logError ?? ((context: string, err: unknown) => {
    console.warn(`[private-preview] ${context}`, err instanceof Error ? err.name : 'UnknownError');
  });
  let lastRunAt: number | undefined;

  return async function sweepPrivatePreviews(): Promise<PrivatePreviewSweepResult> {
    const current = now().getTime();
    if (lastRunAt !== undefined && current - lastRunAt < minIntervalMs) {
      return { checked: 0, destroyed: 0, failed: 0 };
    }
    lastRunAt = current;
    const machines = await listActivePrivatePreviews(opts.db, SWEEP_BATCH_LIMIT);
    let destroyed = 0;
    let failed = 0;
    for (const machine of machines) {
      let ineligible = Date.parse(machine.provisionedAt) + PRIVATE_PREVIEW_TTL_MS <= current;
      if (!ineligible && opts.internalOrganizationId) {
        try {
          ineligible = !await isActiveOrganizationMember(opts.db, opts.internalOrganizationId, machine.clerkUserId);
        } catch (err: unknown) {
          logError(`membership check failed machineId=${machine.machineId}`, err);
        }
      }
      if (!ineligible) continue;
      try {
        await opts.service.delete(machine.machineId);
        destroyed += 1;
      } catch (err: unknown) {
        failed += 1;
        logError(`destroy failed machineId=${machine.machineId}`, err);
      }
    }
    return { checked: machines.length, destroyed, failed };
  };
}
