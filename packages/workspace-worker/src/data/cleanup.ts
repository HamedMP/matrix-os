import type { PostgresWorkspaceRepository } from './repository.js';
import type { R2WorkspaceFiles } from './files.js';

const JOB = 'text-orphans-v1';
const LEASE_MS = 60_000;
const PAGE_BUDGET_MS = 45_000;
const MAX_CURSOR_LENGTH = 2048;
export interface WorkspaceCleanupResult { status: 'completed' | 'busy' | 'stale'; deleted: number }

/** One reference-aware page per cron. Lease fencing prevents competing cursor advancement. */
export async function runWorkspaceFileCleanup(repository: PostgresWorkspaceRepository,
  files: Pick<R2WorkspaceFiles, 'sweepUnreferenced'>,
  options: { now?: () => number } = {},
): Promise<WorkspaceCleanupResult> {
  const now = options.now ?? Date.now;
  const leaseId = crypto.randomUUID();
  const claimed = await repository.db.transaction().execute(async (trx) => {
    await trx.insertInto('shared_cleanup_cursors').values({
      job: JOB, cursor: null, lease_id: null, lease_until: 0,
    }).onConflict((conflict) => conflict.column('job').doNothing()).execute();
    return trx.updateTable('shared_cleanup_cursors').set({ lease_id: leaseId, lease_until: now() + LEASE_MS })
      .where('job', '=', JOB).where('lease_until', '<=', now()).returning('cursor').executeTakeFirst();
  });
  if (!claimed) return { status: 'busy', deleted: 0 };
  if (claimed.cursor !== null && claimed.cursor.length > MAX_CURSOR_LENGTH) throw new Error('Invalid cleanup cursor');

  // An uncertain or timed-out page retains the lease until expiry and never advances its cursor.
  // Retried R2 deletes are idempotent; the 24h grace excludes in-flight immutable uploads.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<ReturnType<R2WorkspaceFiles['sweepUnreferenced']>>;
  try {
    result = await Promise.race([
      files.sweepUnreferenced(keys => repository.referencedObjectKeysForCleanup(keys), {
        now: now(), ...(claimed.cursor !== null ? { cursor: claimed.cursor } : {}),
      }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Cleanup page timed out')), PAGE_BUDGET_MS); }),
    ]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
  if (result.cursor !== undefined && result.cursor.length > MAX_CURSOR_LENGTH) throw new Error('Invalid cleanup cursor');
  const updated = await repository.db.updateTable('shared_cleanup_cursors')
    .set({ cursor: result.cursor ?? null, lease_id: null, lease_until: 0 })
    .where('job', '=', JOB).where('lease_id', '=', leaseId).where('lease_until', '>', now()).returning('job').executeTakeFirst();
  return { status: updated ? 'completed' : 'stale', deleted: result.deleted };
}
