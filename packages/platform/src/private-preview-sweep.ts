import type { CustomerVpsService } from './customer-vps-types.js';
import type { PlatformDB } from './db.js';
import { listActivePrivatePreviews, type PrivatePreviewCursor } from './database/private-previews.js';
import { PRIVATE_PREVIEW_TTL_MS, type PrivatePreviewMembershipLookup } from './private-preview-access.js';

const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGES_PER_PASS = 25;

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
  /** Absent when no organization projection is configured; only expiry then applies. */
  lookupMembership?: PrivatePreviewMembershipLookup;
  now?: () => Date;
  minIntervalMs?: number;
  pageSize?: number;
  maxPagesPerPass?: number;
  logError?: (context: string, err: unknown) => void;
}): () => Promise<PrivatePreviewSweepResult> {
  const now = opts.now ?? (() => new Date());
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const logError = opts.logError ?? ((context: string, err: unknown) => {
    console.warn(`[private-preview] ${context}`, err instanceof Error ? err.name : 'UnknownError');
  });
  let lastRunAt: number | undefined;
  // Where the previous pass stopped when it hit its page bound; the next pass
  // resumes there, so every machine is reached however many are active.
  let resumeAfter: PrivatePreviewCursor | undefined;

  return async function sweepPrivatePreviews(): Promise<PrivatePreviewSweepResult> {
    const current = now().getTime();
    if (lastRunAt !== undefined && current - lastRunAt < minIntervalMs) {
      return { checked: 0, destroyed: 0, failed: 0 };
    }
    lastRunAt = current;
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    let after = resumeAfter;
    let wrapped = resumeAfter === undefined;
    resumeAfter = undefined;
    let checked = 0;
    let destroyed = 0;
    let failed = 0;
    // Page through every active Private Preview so newer machines are reached
    // even when older ones stay eligible; the page bound caps one pass.
    const maxPages = opts.maxPagesPerPass ?? MAX_PAGES_PER_PASS;
    let pages = 0;
    while (pages < maxPages) {
      const machines = await listActivePrivatePreviews(opts.db, pageSize, after);
      if (machines.length === 0) {
        after = undefined;
        // A resumed pass that reaches the end starts over once from the beginning;
        // the empty read does not count against the page bound.
        if (wrapped) break;
        wrapped = true;
        continue;
      }
      pages += 1;
      checked += machines.length;
      for (const machine of machines) {
        // An unparseable provisioning time cannot prove the machine is within its lifetime.
        const provisionedAt = Date.parse(machine.provisionedAt);
        let destroy = !Number.isFinite(provisionedAt) || provisionedAt + PRIVATE_PREVIEW_TTL_MS <= current;
        if (!destroy && opts.internalOrganizationId && opts.lookupMembership) {
          try {
            // Only a freshly verified non-member is removed; "unknown" never is.
            destroy = await opts.lookupMembership(opts.internalOrganizationId, machine.clerkUserId) === 'not_member';
          } catch (err: unknown) {
            logError(`membership check failed machineId=${machine.machineId}`, err);
          }
        }
        if (!destroy) continue;
        try {
          await opts.service.delete(machine.machineId);
          destroyed += 1;
        } catch (err: unknown) {
          failed += 1;
          logError(`destroy failed machineId=${machine.machineId}`, err);
        }
      }
      const last = machines[machines.length - 1];
      after = { provisionedAt: last.provisionedAt, machineId: last.machineId };
      if (machines.length < pageSize) {
        after = undefined;
        break;
      }
    }
    // Still inside the list at the page bound: continue from here next pass.
    resumeAfter = after;
    return { checked, destroyed, failed };
  };
}
