import type { Context } from 'hono';
import { z } from 'zod/v4';
import type { PlatformDb, UsersTable, ConnectedServicesTable } from '../platform-db.js';
import { GoogleCollectionRefusedError, type GoogleCollectionAdmission } from '../integrations/collection-hook.js';
import { createGoogleCollectionAdmission } from './runtime/collection-admission.js';

type CanonicalConnection = Pick<ConnectedServicesTable, 'id' | 'user_id' | 'service' | 'status'>;
type CanonicalUser = Pick<UsersTable, 'id' | 'clerk_id'>;
export interface GoogleCollectionPlatformDb extends Pick<PlatformDb, 'googleData'> {
  getUserById(id: string): Promise<CanonicalUser | null>;
  getUserByClerkId(id: string): Promise<CanonicalUser | null>;
  getConnectedService(id: string): Promise<CanonicalConnection | null>;
}
const Principal = z.strictObject({ ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/), handle: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) });
const Connection = z.object({ id: z.uuid(), user_id: z.uuid(), service: z.literal('gmail'), status: z.literal('active') });
function deny(): never { throw new GoogleCollectionRefusedError(); }
function principal(c: Context) {
  if (c.get('internalSignedOwnerDelegation') !== true) return deny();
  const value = Principal.safeParse({ ownerId: c.get('internalContainerClerkUserId'), handle: c.get('internalContainerHandle') });
  return value.success ? value.data : deny();
}

/** Install ONLY behind the platform's actual machine bearer + signed owner middleware and
 * existing account-deletion mutation admission. Public owner inspection/export does not use
 * this factory. A valid machine envelope is not remote live-run or all-egress qualification. */
export function createGoogleCollectionAdmissionForPlatform(options: {
  db: GoogleCollectionPlatformDb;
  /** Derive from the authenticated context handle using the platform's secret; never request JSON/headers. */
  machineTokenForHandle(handle: string): string | Promise<string>;
  now?: () => Date;
}): GoogleCollectionAdmission {
  const { db } = options; const services = db?.googleData;
  if (!services || ![services.repository?.snapshot, services.authority?.assertAuthorized, services.authority?.revalidate,
    services.requestLedger?.consume, db.getUserById, db.getUserByClerkId, db.getConnectedService,
    options.machineTokenForHandle].every(value => typeof value === 'function')) deny();
  return {
    async admit(c, rawConnection, path) {
      try {
        const expected = principal(c); const connection = Connection.parse(rawConnection);
        if (connection.id !== connection.id.toLowerCase() || connection.user_id !== connection.user_id.toLowerCase()
          || path !== '/call' && path !== '/read-call') deny();
        const current = () => {
          const value = principal(c);
          if (c.req.raw.signal.aborted || value.ownerId !== expected.ownerId || value.handle !== expected.handle) deny();
        };
        current();
        const user = await db.getUserById(connection.user_id); current();
        if (!user || user.id !== connection.user_id || user.clerk_id !== expected.ownerId) deny();
        // Hono json() caches text; never JSON.stringify a parsed body before envelope verification.
        const body = await c.req.text(); current();
        const receiver = createGoogleCollectionAdmission({ repository: services.repository, authority: services.authority,
          ledger: services.requestLedger, now: options.now,
          resolveRuntime: async context => {
            if (context !== c) deny(); current();
            const machineToken = await options.machineTokenForHandle(expected.handle); current();
            if (typeof machineToken !== 'string' || machineToken.length < 16 || machineToken.length > 4096) deny();
            return { ownerId: expected.ownerId, machineToken };
          },
          ownsGmailAccount: async (ownerId, googleAccountId) => {
            current();
            const [owner, account] = await Promise.all([db.getUserByClerkId(ownerId), db.getConnectedService(googleAccountId)]); current();
            return Boolean(ownerId === expected.ownerId && googleAccountId === connection.id && owner && owner.id === connection.user_id
              && owner.clerk_id === expected.ownerId && account && account.id === connection.id
              && account.user_id === owner.id && account.service === 'gmail' && account.status === 'active');
          },
        });
        return await receiver.admit({ context: c, ownerId: expected.ownerId, googleAccountId: connection.id, path, body });
      } catch (_error) { throw new GoogleCollectionRefusedError(); }
    },
  };
}
