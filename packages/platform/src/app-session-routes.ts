import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  MATRIX_HOSTED_BILLING_PLAN_SLUGS,
  MATRIX_HOSTED_BILLING_REGIONS,
  MATRIX_HOSTED_BILLING_REGION_SLUGS,
  resolveMatrixMachineProfile,
} from '@matrix-os/contracts';
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
import {
  DeveloperToolsSchema,
  resolveProvisioningDeveloperTools,
} from './developer-tools.js';
import { getActivePrebillingIntent } from './prebilling-provisioning-store.js';
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
  planSlug: z.enum(MATRIX_HOSTED_BILLING_PLAN_SLUGS).optional(),
  regionSlug: z.enum(MATRIX_HOSTED_BILLING_REGION_SLUGS).optional(),
  // Temporary compatibility for already-deployed shell bundles. New clients
  // send planSlug + regionSlug and never select provider infrastructure.
  serverType: HetznerServerTypeSchema.optional(),
  location: HetznerLocationSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.planSlug === undefined) !== (value.regionSlug === undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Plan and region must be selected together',
      path: value.planSlug === undefined ? ['planSlug'] : ['regionSlug'],
    });
  }
});

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
  resumePrebillingPreparation?: (input: { intentId: string; clerkUserId: string }) => Promise<boolean>;
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
    runtimeSlot?: string,
    env?: NodeJS.ProcessEnv,
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
        const entitlement = await opts.resolveEffectiveBillingEntitlement(
          opts.db,
          result.userId,
          now,
          parsed.data.runtime,
          opts.appEnv,
        );
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

      const prebillingIntent = await getActivePrebillingIntent(
        opts.db,
        result.userId,
        parsed.data.runtime,
      );
      if (prebillingIntent) {
        const resumed = await opts.resumePrebillingPreparation?.({
          intentId: prebillingIntent.id,
          clerkUserId: result.userId,
        });
        opts.applyNoStoreHeaders(c);
        if (!resumed) {
          return c.json({ error: 'Provisioning unavailable', code: 'provisioning_unavailable' }, 503);
        }
        return c.json({
          runtime: 'customer_vps',
          runtimeSlot: parsed.data.runtime,
          status: 'provisioning',
          intentId: prebillingIntent.id,
        }, 202);
      }

      const identity = await opts.selectProvisionIdentityForClerkUser(opts.db, result.userId, opts.appEnv);
      if (!identity) {
        opts.applyNoStoreHeaders(c);
        return c.json({ error: 'Handle unavailable', code: 'handle_unavailable' }, 409);
      }
      const checkoutAttempt = await getSettlingCheckoutAttempt(
        opts.db,
        result.userId,
        parsed.data.runtime,
      );
      const settlingCheckoutDeveloperTools = (
        checkoutAttempt &&
        (checkoutAttempt.status === 'paid' || checkoutAttempt.status === 'open')
          ? checkoutAttempt.developerTools
          : undefined
      );
      const settlingCheckoutRegion = checkoutAttempt?.regionSlug
        ? MATRIX_HOSTED_BILLING_REGIONS.find((region) => region.slug === checkoutAttempt.regionSlug)
        : undefined;
      const requestedProfile = parsed.data.planSlug && parsed.data.regionSlug
        ? resolveMatrixMachineProfile(parsed.data.planSlug, parsed.data.regionSlug)
        : undefined;
      const requestedRegion = parsed.data.regionSlug
        ? MATRIX_HOSTED_BILLING_REGIONS.find((region) => region.slug === parsed.data.regionSlug)
        : undefined;
      const developerTools = resolveProvisioningDeveloperTools(
        settlingCheckoutDeveloperTools ?? parsed.data.developerTools,
        undefined,
      );
      const serverType = checkoutAttempt?.serverType ?? requestedProfile?.serverType ?? parsed.data.serverType;
      const location = settlingCheckoutRegion?.location ?? requestedRegion?.location ?? parsed.data.location;
      const provisioned = await opts.customerVpsService.provision(
        {
          handle: identity.handle,
          clerkUserId: result.userId,
          runtimeSlot: parsed.data.runtime,
          ...(developerTools !== undefined ? { developerTools } : {}),
          ...(serverType ? { serverType } : {}),
          ...(location ? { location } : {}),
        },
        { dispatch: 'detached' },
      );
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
        const entitlement = await opts.resolveEffectiveBillingEntitlement(
          opts.db,
          result.userId,
          now,
          requestedRuntimeSlot,
          opts.appEnv,
        );
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
