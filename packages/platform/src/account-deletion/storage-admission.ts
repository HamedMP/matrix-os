import type { MiddlewareHandler } from 'hono';
import type { PlatformDB } from '../db.js';
import { withAccountDeletionOwnerLock } from './admission.js';

const READ_OPERATIONS = ['/presign/get', '/system/exists', '/system/presign/get', '/multipart/list', '/object/head'] as const;

/** Authentication must set the owner before this runs. Hold the fence through signing/object writes. */
export function createStorageDeletionAdmissionMiddleware(db: PlatformDB): MiddlewareHandler {
  return async (c, next) => {
    const owner = c.get('internalSyncUserId') as string | undefined;
    if (!owner) return c.json({ error: 'Storage unavailable' }, 503);
    const syncMarker = c.req.path.lastIndexOf('/sync/');
    const suffix = syncMarker < 0 ? c.req.path : c.req.path.slice(syncMarker + '/sync'.length);
    const read = c.req.method === 'GET' && suffix === '/object'
      || c.req.method === 'POST' && READ_OPERATIONS.some((operation) => suffix === operation);
    try {
      return await withAccountDeletionOwnerLock(db, owner, async (_trx, admission) => {
        if (admission.runtimeAccess === 'blocked' || (!read && !admission.newWorkAllowed)) {
          return c.json({ error: 'Account deletion is pending' }, 409);
        }
        await next();
      });
    } catch (error: unknown) {
      console.error('[account-deletion] storage admission failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Storage unavailable' }, 503);
    }
  };
}
