import { randomBytes, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import {
  OWNED_MACHINE_LIMIT_PER_ACCOUNT,
  OwnedComputerUpdateRequestSchema,
  OwnedEnrollApproveRequestSchema,
  OwnedMachineUserCodeSchema,
} from '@matrix-os/contracts';
import type { ClerkAuth } from '../clerk-auth.js';
import type { PlatformDB } from '../db.js';
import { isPlatformHandleAvailableForClerkUser } from '../db.js';
import { formatUserCode } from '../device-flow.js';
import { createBoundedRateLimiter } from '../request-admission.js';
import { AccountDeletionAdmissionError, withAccountDeletionAdmission } from '../account-deletion/admission.js';
import { resolveAppDomainIdentity } from '../session-routing-identity.js';
import type { OwnedMachinesConfig } from './config.js';
import { ownedConnectPage } from './connect-page.js';
import { readOwnedJson } from './machine-routes.js';
import {
  approveOwnedEnrollment,
  getOwnedMachineLink,
  getPendingEnrollmentByUserCode,
  listOwnedMachineLinks,
  revokeOwnedMachine,
  toOwnedComputerSummary,
  updateOwnedComputer,
  type OwnedRevocationHook,
} from './repository.js';

const OWNER_BODY_LIMIT = 4 * 1024;
const MachineIdParamSchema = z.object({ machineId: z.string().uuid() });
const LookupSchema = z.object({ userCode: OwnedMachineUserCodeSchema }).strict();
const ConnectQuerySchema = z.object({ code: z.string().max(16).regex(/^[A-Za-z -]*$/).optional() });

export interface OwnedOwnerRoutesDeps {
  db: PlatformDB;
  config: OwnedMachinesConfig | null;
  clerkAuth?: ClerkAuth;
  platformJwtSecret: string;
  publishableKey: string | null;
  resolveHandle: (clerkUserId: string) => Promise<string | null>;
  revocationHooks?: readonly OwnedRevocationHook[];
  resolveIdentity?: typeof resolveAppDomainIdentity;
  now?: () => Date;
  log: (route: string, err: unknown) => void;
}

function noStore(c: Context): void {
  c.header('Cache-Control', 'no-store, private');
  c.header('CDN-Cache-Control', 'no-store');
}

export function createOwnedOwnerRoutes(deps: OwnedOwnerRoutesDeps): Hono {
  const routes = new Hono();
  const now = () => deps.now?.() ?? new Date();
  const resolveIdentity = deps.resolveIdentity ?? resolveAppDomainIdentity;
  const principalLimiter = createBoundedRateLimiter(30);
  const lookupLimiter = createBoundedRateLimiter(10);
  const limit = bodyLimit({ maxSize: OWNER_BODY_LIMIT, onError: (c) => c.json({ error: 'Request too large' }, 413) });

  /**
   * Mutations accept only an explicit bearer (Clerk session token or Matrix
   * device token), never cookies, so a cross-site form cannot drive them.
   */
  async function principal(c: Context, allowCookie: boolean): Promise<string | null> {
    const identity = await resolveIdentity({
      authHeader: c.req.header('authorization'),
      cookieHeader: allowCookie ? c.req.header('cookie') : undefined,
      clerkAuth: deps.clerkAuth,
      db: deps.db,
      platformJwtSecret: deps.platformJwtSecret,
      allowUnroutedClerkIdentity: true,
      clerkPrincipalOnly: true,
      runtimeSlot: 'primary',
    });
    return identity?.userId ?? null;
  }

  /**
   * Cookie sessions may mutate only from the app's own origin (the shell served
   * through session routing, including on an owned computer). Cross-site forms
   * carry a foreign Origin, or none, and fall back to bearer-only.
   */
  function sameAppOrigin(c: Context): boolean {
    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');
    return Boolean(deps.config && origin && origin === new URL(deps.config.publicUrl).origin
      && (site === undefined || site === 'same-origin'));
  }

  async function guard(c: Context, allowCookie: boolean): Promise<string | Response> {
    noStore(c);
    if (!deps.config) return c.json({ error: 'Owned computers unavailable' }, 503);
    let userId: string | null;
    try {
      userId = await principal(c, allowCookie);
    } catch (err: unknown) {
      deps.log('owned computers auth', err);
      return c.json({ error: 'Owned computers unavailable' }, 503);
    }
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    if (!principalLimiter.check(userId)) return c.json({ error: 'Too many requests' }, 429);
    return userId;
  }

  routes.get('/connect', (c) => {
    noStore(c);
    const nonce = randomBytes(16).toString('base64');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy',
      `frame-ancestors 'none'; script-src 'self' 'nonce-${nonce}' https://clerk.matrix-os.com https://challenges.cloudflare.com; `
      + "worker-src 'self' blob:; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: https://img.clerk.com; connect-src 'self' https://clerk.matrix-os.com; object-src 'none'; base-uri 'none'");
    const query = ConnectQuerySchema.safeParse({ code: c.req.query('code') });
    return c.html(ownedConnectPage({ code: query.success ? query.data.code ?? '' : '', publishableKey: deps.publishableKey, nonce }));
  });

  routes.post('/api/auth/owned-enrollments/lookup', limit, async (c) => {
    const userId = await guard(c, false);
    if (typeof userId !== 'string') return userId;
    if (!lookupLimiter.check(userId)) return c.json({ error: 'Too many requests' }, 429);
    const parsed = LookupSchema.safeParse(await readOwnedJson(c));
    if (!parsed.success) return c.json({ error: 'Invalid request', code: 'not_found' }, 400);
    try {
      const pending = await getPendingEnrollmentByUserCode(deps.db, parsed.data.userCode, now());
      if (!pending) return c.json({ error: 'Not found', code: 'not_found' }, 404);
      return c.json({ userCode: formatUserCode(pending.userCode), report: pending.report, expiresAt: pending.expiresAt.toISOString() });
    } catch (err: unknown) {
      deps.log('/api/auth/owned-enrollments/lookup', err);
      return c.json({ error: 'Owned computers unavailable', code: 'unavailable' }, 503);
    }
  });

  routes.post('/api/auth/owned-enrollments/approve', limit, async (c) => {
    const userId = await guard(c, false);
    if (typeof userId !== 'string') return userId;
    const parsed = OwnedEnrollApproveRequestSchema.safeParse(await readOwnedJson(c));
    if (!parsed.success) return c.json({ error: 'Invalid request', code: 'not_found' }, 400);
    try {
      // The handle lookup may call Clerk; it stays outside the approval transaction.
      const handle = await deps.resolveHandle(userId);
      if (!handle) return c.json({ error: 'Handle unavailable', code: 'handle_unavailable' }, 409);
      // Account deletion admission holds the owner lock through the approval writes,
      // so a computer cannot be connected after erasure was scheduled.
      const result = await withAccountDeletionAdmission(deps.db, userId, (trx) => approveOwnedEnrollment(trx, {
        userCode: parsed.data.userCode,
        clerkUserId: userId,
        handle,
        name: parsed.data.name,
        machineId: randomUUID(),
        runtimeSlot: `owned-${randomBytes(4).toString('hex')}`,
        now: now(),
        isHandleAvailable: isPlatformHandleAvailableForClerkUser,
      }));
      if (!result.ok) {
        const status = result.reason === 'not_found' ? 404 : 409;
        return c.json({ error: 'Cannot connect computer', code: result.reason }, status);
      }
      return c.json({
        machineId: result.machine.machineId,
        handle: result.machine.handle,
        runtimeSlot: result.machine.runtimeSlot,
      }, 201);
    } catch (err: unknown) {
      if (err instanceof AccountDeletionAdmissionError) {
        return c.json({ error: 'Cannot connect computer', code: 'account_deletion_pending' }, 409);
      }
      deps.log('/api/auth/owned-enrollments/approve', err);
      return c.json({ error: 'Owned computers unavailable', code: 'unavailable' }, 503);
    }
  });

  routes.get('/api/auth/owned-computers', async (c) => {
    const userId = await guard(c, true);
    if (typeof userId !== 'string') return userId;
    try {
      const at = now();
      const links = await listOwnedMachineLinks(deps.db, userId);
      return c.json({ computers: links.map((link) => toOwnedComputerSummary(link, at)), limit: OWNED_MACHINE_LIMIT_PER_ACCOUNT });
    } catch (err: unknown) {
      deps.log('/api/auth/owned-computers', err);
      return c.json({ error: 'Owned computers unavailable' }, 503);
    }
  });

  routes.patch('/api/auth/owned-computers/:machineId', limit, async (c) => {
    const userId = await guard(c, sameAppOrigin(c));
    if (typeof userId !== 'string') return userId;
    const params = MachineIdParamSchema.safeParse(c.req.param());
    const body = OwnedComputerUpdateRequestSchema.safeParse(await readOwnedJson(c));
    if (!params.success || !body.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const updated = await updateOwnedComputer(deps.db, { clerkUserId: userId, machineId: params.data.machineId, ...body.data });
      if (!updated) return c.json({ error: 'Not found' }, 404);
      const link = await getOwnedMachineLink(deps.db, params.data.machineId);
      if (!link) return c.json({ error: 'Not found' }, 404);
      return c.json(toOwnedComputerSummary(link, now()));
    } catch (err: unknown) {
      deps.log('/api/auth/owned-computers patch', err);
      return c.json({ error: 'Owned computers unavailable' }, 503);
    }
  });

  routes.delete('/api/auth/owned-computers/:machineId', limit, async (c) => {
    const userId = await guard(c, sameAppOrigin(c));
    if (typeof userId !== 'string') return userId;
    const params = MachineIdParamSchema.safeParse(c.req.param());
    if (!params.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const revoked = await revokeOwnedMachine(deps.db, {
        machineId: params.data.machineId, clerkUserId: userId, now: now(), hooks: deps.revocationHooks,
      });
      return revoked ? c.body(null, 204) : c.json({ error: 'Not found' }, 404);
    } catch (err: unknown) {
      deps.log('/api/auth/owned-computers delete', err);
      return c.json({ error: 'Owned computers unavailable' }, 503);
    }
  });

  return routes;
}
