import type { GoogleManagedRouteResolver } from './runtime/profile-resolution.js';
import type { Hono, Context } from 'hono';
import type { PlatformDb } from '../platform-db.js';
import { createGoogleDataOwnerRoutes } from './owner-routes.js';
import { registerGooglePlatformPolicyRoutes } from './register-platform-routes.js';

/** Reuse the integration database's verified principal mapping. Both native
 * and Pipedream Gmail accounts have the same exact canonical owner check. */
export function registerGoogleDataOwnerRoutes(app: Hono, db: PlatformDb, resolveUserId: (c: Context) => Promise<string | null>, options: { resolveManagedRoute?: GoogleManagedRouteResolver } = {}) {
  if (!db.googleData) return;
  registerGooglePlatformPolicyRoutes(app, db, resolveUserId, options);
  app.route('/', createGoogleDataOwnerRoutes({ ...db.googleData,
    resolveOwner: async c => {
      const userId = await resolveUserId(c);
      return userId ? (await db.getUserById(userId))?.clerk_id ?? null : null;
    },
    ownsGoogleAccount: async (ownerId, connectionId) => {
      const [user, account] = await Promise.all([db.getUserByClerkId(ownerId), db.getConnectedService(connectionId)]);
      return Boolean(user && account && account.user_id === user.id && account.service === 'gmail');
    },
  }));
}
