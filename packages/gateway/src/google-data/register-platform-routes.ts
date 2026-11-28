import type { GoogleManagedRouteResolver } from './runtime/profile-resolution.js';
import type { Hono, Context } from 'hono';
import type { PlatformDb } from '../platform-db.js';
import { createGooglePlatformPolicyRoutes } from './runtime/platform-routes.js';

/** The platform's machine bearer guard alone sets these private context values.
 * Public owner sessions and legacy unsigned owner delegation cannot use this
 * policy seam. A policy response still requires live gateway run admission. */
export function registerGooglePlatformPolicyRoutes(app: Hono, db: PlatformDb,
  resolveUserId: (c: Context) => Promise<string | null>, options: { resolveManagedRoute?: GoogleManagedRouteResolver } = {}) {
  if (!db.googleData) return;
  app.route('/', createGooglePlatformPolicyRoutes({ repository: db.googleData.repository,
    ...(options.resolveManagedRoute ? { resolveManagedRoute: options.resolveManagedRoute } : {}),
    resolveRuntime: async c => {
      const ownerId: unknown = c.get('internalContainerClerkUserId');
      const machineId: unknown = c.get('internalContainerHandle');
      if (c.get('internalSignedOwnerDelegation') !== true || typeof ownerId !== 'string' || typeof machineId !== 'string') return null;
      const userId = await resolveUserId(c);
      const user = userId ? await db.getUserById(userId) : null;
      return user?.clerk_id === ownerId ? { ownerId, machineId } : null;
    },
    ownsGmailAccount: async (ownerId, connectionId) => {
      const [user, account] = await Promise.all([db.getUserByClerkId(ownerId), db.getConnectedService(connectionId)]);
      return Boolean(user && account && account.user_id === user.id && account.service === 'gmail' && account.status === 'active');
    },
  }));
}
