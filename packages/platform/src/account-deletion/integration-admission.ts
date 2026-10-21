import type { Context, MiddlewareHandler } from 'hono';
import type { PlatformDB } from '../db.js';
import { getAccountDeletionAdmission, withAccountDeletionOwnerLock } from './admission.js';

/** Surface authentication resolves the Clerk owner. Platform DB calls reuse the admitted transaction. */
export function createAccountDeletionMutationGuard(options: {
  db: PlatformDB;
  resolveOwner: (context: Context) => string | null | undefined | Promise<string | null | undefined>;
  env?: NodeJS.ProcessEnv;
  isMutation?: (context: Context) => boolean;
}): MiddlewareHandler {
  const env = options.env ?? process.env;
  return async (c, next) => {
    if (env.ACCOUNT_DELETION_SECRET === undefined) return next();
    try {
      const owner = await options.resolveOwner(c);
      if (!owner || owner.length > 160 || !/^[A-Za-z0-9_-]+$/.test(owner)) return c.json({ error: 'Unauthorized' }, 401);
      const mutation = options.isMutation?.(c)
        ?? (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.req.path.endsWith('/oauth/callback'));
      if (!mutation) {
        if ((await getAccountDeletionAdmission(options.db, owner, env)).runtimeAccess === 'blocked') {
          return c.json({ error: 'Account deletion is pending' }, 409);
        }
        await next();
        return;
      }
      return await withAccountDeletionOwnerLock(options.db, owner, async (_trx, admission) => {
        if (!admission.newWorkAllowed) return c.json({ error: 'Account deletion is pending' }, 409);
        await next();
        // Hono captures handler exceptions into c.error. Preserve transaction rollback.
        if (c.error) throw c.error;
        if (c.res.status >= 500) throw new Error('Integration mutation failed');
      }, env);
    } catch (error: unknown) {
      console.error('[account-deletion] integration admission failed:', error instanceof Error ? error.name : typeof error);
      return c.json({ error: 'Connection unavailable' }, 503);
    }
  };
}
