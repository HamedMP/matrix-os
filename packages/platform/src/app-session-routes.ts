import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';

import {
  getAccessibleActiveUserMachineByClerkId,
  getContainerByClerkId,
  getSettlingCheckoutAttempt,
  type PlatformDB,
} from './db.js';
import type { BillingEntitlement } from './billing.js';
import { getRuntimeAccessDecision } from './billing.js';
import type { ClerkAuth } from './clerk-auth.js';
import type { CustomerVpsService } from './customer-vps.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { HetznerLocationSchema, HetznerServerTypeSchema, RuntimeSlotSchema } from './customer-vps-schema.js';
import { DeveloperToolsSchema } from './developer-tools.js';
import type { MatrixProvisioner } from './matrix-provisioning.js';
import {
  normalizePostAuthRedirectPath,
  readRuntimeSlotSelection,
} from './request-routing.js';
import {
  appendSignOutClearCookies,
  buildAppSessionCookie,
  buildClearAppSessionCookie,
  buildClearNativeAppSessionCookie,
  buildNativeAppSessionCookie,
  CODE_SESSION_EXPIRES_IN_SEC,
} from './session-cookies.js';
import { issueSyncJwt } from './sync-jwt.js';

const APP_SESSION_BODY_LIMIT = 1024;

const AppSessionExchangeBodySchema = z.object({
  redirectTo: z.string().min(1).max(2048).optional(),
  runtime: RuntimeSlotSchema.optional(),
}).strict();

const AppSessionProvisionBodySchema = z.object({
  runtime: RuntimeSlotSchema.optional().default('primary'),
  developerTools: DeveloperToolsSchema.optional(),
  serverType: HetznerServerTypeSchema.optional(),
  location: HetznerLocationSchema.optional(),
}).strict();

interface ProvisionIdentity {
  handle: string;
  displayName: string;
  email?: string;
}

interface AppDomainIdentity {
  handle: string;
  userId: string;
  runtimeSlot?: string;
  source?: 'auth' | 'mobile-session' | 'static-route';
}

export function createAppSessionRoutes(opts: {
  db: PlatformDB;
  clerkAuth?: ClerkAuth;
  customerVpsService?: CustomerVpsService;
  matrixProvisioner?: MatrixProvisioner;
  appEnv: NodeJS.ProcessEnv;
  platformJwtSecret: string;
  legacyContainerRoutingEnabled: boolean;
  logRouteError: (route: string, err: unknown) => void;
  applyNoStoreHeaders: (c: Context) => void;
  jsonCustomerVpsError: (c: Context, err: unknown, context: string) => Response | Promise<Response>;
  stripeBillingEntitlementsEnabled: (env: NodeJS.ProcessEnv) => boolean;
  resolveEffectiveBillingEntitlement: (
    db: PlatformDB,
    clerkUserId: string,
    now?: Date,
  ) => Promise<BillingEntitlement | null>;
  selectProvisionIdentityForClerkUser: (
    db: PlatformDB,
    userId: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<ProvisionIdentity | null>;
  ensureProvisionedPlatformUser: (
    db: PlatformDB,
    input: {
      clerkUserId: string;
      handle: string;
      displayName?: string;
      email?: string;
      runtimeId: string;
    },
  ) => Promise<void>;
  resolveAppDomainIdentity: (identityOpts: {
    authHeader: string | undefined;
    cookieHeader: string | undefined;
    db: PlatformDB;
    platformJwtSecret: string;
    legacyContainerRoutingEnabled?: boolean;
    runtimeSlot: string;
  }) => Promise<AppDomainIdentity | null>;
  getGatewayUrlForHandle: (handle: string) => string;
}) {
  const routes = new Hono();

  routes.delete('/api/auth/app-session', bodyLimit({ maxSize: APP_SESSION_BODY_LIMIT }), async (c) => {
    let clerkSessionRevoked = false;
    const clerkToken = opts.clerkAuth?.extractToken(undefined, c.req.header('cookie'));
    if (opts.clerkAuth && clerkToken) {
      const result = await opts.clerkAuth.verify(clerkToken);
      if (result.authenticated && result.sessionId) {
        try {
          clerkSessionRevoked = await opts.clerkAuth.revokeSession(result.sessionId);
        } catch (err: unknown) {
          if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
            console.warn('[auth/app-session] Clerk session revoke timed out', err.name);
          } else {
            console.warn('[auth/app-session] Clerk session revoke failed', err instanceof Error ? err.name : typeof err);
          }
        }
      }
    }
    opts.applyNoStoreHeaders(c);
    appendSignOutClearCookies(c);
    return c.json({ cleared: true, clerkSessionRevoked });
  });

  routes.post('/api/auth/provision-runtime', bodyLimit({ maxSize: APP_SESSION_BODY_LIMIT }), async (c) => {
    if (!opts.clerkAuth) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!opts.customerVpsService) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Provisioning unavailable', code: 'provisioning_unavailable' }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        opts.logRouteError('/api/auth/provision-runtime parse', err);
      }
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Invalid request' }, 400);
    }
    const parsed = AppSessionProvisionBodySchema.safeParse(body);
    if (!parsed.success) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Invalid request' }, 400);
    }

    const token = opts.clerkAuth.extractToken(c.req.header('authorization'), c.req.header('cookie'));
    if (!token) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const result = await opts.clerkAuth.verify(token);
    if (!result.authenticated || !result.userId) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      if (opts.stripeBillingEntitlementsEnabled(opts.appEnv)) {
        const now = new Date();
        const entitlement = await opts.resolveEffectiveBillingEntitlement(opts.db, result.userId, now);
        const access = getRuntimeAccessDecision(entitlement, now);
        if (!access.runtimeProxyAllowed) {
          opts.applyNoStoreHeaders(c);
          return opts.jsonCustomerVpsError(
            c,
            new CustomerVpsError(402, 'billing_required', 'Billing upgrade required'),
            '/api/auth/provision-runtime',
          );
        }
      }

      const identity = await opts.selectProvisionIdentityForClerkUser(opts.db, result.userId, opts.appEnv);
      if (!identity) {
        opts.applyNoStoreHeaders(c);
        return c.json({ error: 'Handle unavailable', code: 'handle_unavailable' }, 409);
      }
      const checkoutAttempt = parsed.data.developerTools
        ? null
        : await getSettlingCheckoutAttempt(opts.db, result.userId);
      const developerTools = parsed.data.developerTools ?? (
        checkoutAttempt &&
        (checkoutAttempt.status === 'paid' || checkoutAttempt.status === 'open')
          ? checkoutAttempt.developerTools
          : undefined
      );
      const provisioned = await opts.customerVpsService.provision({
        handle: identity.handle,
        clerkUserId: result.userId,
        runtimeSlot: parsed.data.runtime,
        ...(developerTools ? { developerTools } : {}),
        ...(parsed.data.serverType ? { serverType: parsed.data.serverType } : {}),
        ...(parsed.data.location ? { location: parsed.data.location } : {}),
      });
      await opts.ensureProvisionedPlatformUser(opts.db, {
        clerkUserId: result.userId,
        handle: identity.handle,
        displayName: identity.displayName,
        email: identity.email,
        runtimeId: `vps:${provisioned.machineId}`,
      });
      if (opts.matrixProvisioner) {
        try {
          await opts.matrixProvisioner.provisionUser(identity.handle);
        } catch (matrixErr: unknown) {
          console.error(
            `[matrix] Failed to provision Matrix accounts for ${identity.handle}:`,
            matrixErr instanceof Error ? matrixErr.message : String(matrixErr),
          );
        }
      }
      opts.applyNoStoreHeaders(c);
      return c.json({
        runtime: 'customer_vps',
        handle: identity.handle,
        clerkUserId: result.userId,
        ...provisioned,
        runtimeSlot: parsed.data.runtime,
      }, 202);
    } catch (err: unknown) {
      opts.applyNoStoreHeaders(c);
      return opts.jsonCustomerVpsError(c, err, '/api/auth/provision-runtime');
    }
  });

  routes.post('/api/auth/app-session', bodyLimit({ maxSize: APP_SESSION_BODY_LIMIT }), async (c) => {
    if (!opts.platformJwtSecret) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Session unavailable' }, 503);
    }

    let body: unknown = {};
    if ((c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
      try {
        body = await c.req.json();
      } catch (err: unknown) {
        console.warn('[auth/app-session] JSON parse failed:', err instanceof Error ? err.name : typeof err);
        opts.applyNoStoreHeaders(c);
        return c.json({ error: 'Validation error' }, 400);
      }
    }
    const parsed = AppSessionExchangeBodySchema.safeParse(body);
    if (!parsed.success) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Validation error' }, 400);
    }
    const redirectTo = normalizePostAuthRedirectPath(parsed.data.redirectTo);
    const requestedRuntimeSlot =
      parsed.data.runtime ?? readRuntimeSlotSelection(new URL(redirectTo, 'https://app.matrix-os.com').toString()).slot;
    const authHeader = c.req.header('authorization');

    if (authHeader?.startsWith('Bearer ')) {
      try {
        const nativeIdentity = await opts.resolveAppDomainIdentity({
          authHeader,
          cookieHeader: undefined,
          db: opts.db,
          platformJwtSecret: opts.platformJwtSecret,
          legacyContainerRoutingEnabled: opts.legacyContainerRoutingEnabled,
          runtimeSlot: requestedRuntimeSlot,
        });
        if (nativeIdentity) {
          const nativeToken = authHeader.slice(7);
          opts.applyNoStoreHeaders(c);
          c.header('Set-Cookie', buildAppSessionCookie(nativeToken), { append: true });
          c.header('Set-Cookie', buildNativeAppSessionCookie(nativeToken, opts.platformJwtSecret), { append: true });
          return c.json({ redirectTo });
        }
      } catch (err: unknown) {
        opts.logRouteError('/api/auth/app-session native exchange', err);
        opts.applyNoStoreHeaders(c);
        return c.json({ error: 'Session unavailable' }, 503);
      }
    }

    if (!opts.clerkAuth) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Session unavailable' }, 503);
    }

    const token = opts.clerkAuth.extractToken(authHeader, c.req.header('cookie'));
    if (!token) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const result = await opts.clerkAuth.verify(token);
    if (!result.authenticated || !result.userId) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const record = opts.legacyContainerRoutingEnabled
      ? await getContainerByClerkId(opts.db, result.userId)
      : undefined;
    let machine = record
      ? undefined
      : await getAccessibleActiveUserMachineByClerkId(opts.db, result.userId, requestedRuntimeSlot);
    if (!record && !machine && requestedRuntimeSlot === 'primary') {
      machine = await getAccessibleActiveUserMachineByClerkId(opts.db, result.userId);
    }
    const handle = record?.handle ?? machine?.handle;
    if (!handle) {
      opts.applyNoStoreHeaders(c);
      c.header('Set-Cookie', buildClearAppSessionCookie(), { append: true });
      c.header('Set-Cookie', buildClearNativeAppSessionCookie(), { append: true });
      if (opts.stripeBillingEntitlementsEnabled(opts.appEnv)) {
        const now = new Date();
        const entitlement = await opts.resolveEffectiveBillingEntitlement(opts.db, result.userId, now);
        const access = getRuntimeAccessDecision(entitlement, now);
        if (!access.runtimeProxyAllowed) {
          return opts.jsonCustomerVpsError(
            c,
            new CustomerVpsError(402, 'billing_required', 'Billing upgrade required'),
            '/api/auth/app-session',
          );
        }
      }
      return c.json({ error: 'Matrix computer unavailable', code: 'no_runtime' }, 404);
    }

    const issued = await issueSyncJwt({
      secret: opts.platformJwtSecret,
      clerkUserId: result.userId,
      handle,
      gatewayUrl: opts.getGatewayUrlForHandle(handle),
      runtimeSlot: machine?.runtimeSlot,
      expiresInSec: CODE_SESSION_EXPIRES_IN_SEC,
    });
    opts.applyNoStoreHeaders(c);
    c.header('Set-Cookie', buildAppSessionCookie(issued.token), { append: true });
    c.header('Set-Cookie', buildClearNativeAppSessionCookie(), { append: true });
    return c.json({ redirectTo });
  });

  return routes;
}
