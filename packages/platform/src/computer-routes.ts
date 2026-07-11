import { isIP } from 'node:net';
import {
  MatrixComputerListSchema,
  MatrixComputerSchema,
  RuntimeSelectionRequestSchema,
  RuntimeSelectionResponseSchema,
  type MatrixComputer,
  type MatrixComputerAvailability,
  type MatrixComputerVersionLabel,
} from '@matrix-os/contracts';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { ClerkAuth } from './clerk-auth.js';
import {
  getRunningUserMachineByClerkId,
  type PlatformDB,
} from './db.js';
import {
  listUserRuntimeComputersByClerkId,
  type UserRuntimeComputerRecord,
} from './computer-repository.js';
import { isPreviewMachine } from './customer-vps-preview.js';
import { timingSafeTokenEquals } from './platform-token.js';
import {
  resolveAppDomainIdentity,
  resolveSyncBearerIdentity,
  type AppDomainIdentity,
} from './session-routing-identity.js';
import { EDGE_SECRET_HEADER } from './session-routing-proxy.js';
import { getTrustedSessionRouteHost } from './session-routing-websocket.js';
import { issueSyncJwt } from './sync-jwt.js';
import { isAppDomainHost, isCodeDomainHost } from './ws-upgrade.js';

const COMPUTER_LIST_LIMIT = 20;
const COMPUTER_QUERY_LIMIT = COMPUTER_LIST_LIMIT + 1;
const COMPUTER_CAPABILITIES = ['matrixComputerInventoryV1'] as const;
const RUNTIME_SELECTION_BODY_LIMIT = 1024;
const RUNTIME_SELECTION_EXPIRY_SKEW_SECONDS = 60;
const RUNTIME_SELECTION_RATE_WINDOW_MS = 60_000;
const RUNTIME_SELECTION_SOURCE_RATE_MAX = 60;
const RUNTIME_SELECTION_PRINCIPAL_RATE_MAX = 30;
const RUNTIME_SELECTION_RATE_MAX_KEYS = 10_000;
const RELEASE_DATE_PATTERN = /^(?:v|matrix-os-host-)(\d{4}\.\d{2}\.\d{2})(?:$|-)/;

interface RateWindow {
  count: number;
  resetAt: number;
}

function createBoundedRateLimiter(maxAttempts: number) {
  const windows = new Map<string, RateWindow>();
  return {
    check(key: string): boolean {
      const now = Date.now();
      const existing = windows.get(key);
      const window = !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + RUNTIME_SELECTION_RATE_WINDOW_MS }
        : existing;
      if (window.count >= maxAttempts) {
        windows.delete(key);
        windows.set(key, window);
        return false;
      }
      window.count += 1;
      windows.delete(key);
      windows.set(key, window);
      if (windows.size > RUNTIME_SELECTION_RATE_MAX_KEYS) {
        const oldestKey = windows.keys().next().value;
        if (oldestKey !== undefined && oldestKey !== key) windows.delete(oldestKey);
      }
      return true;
    },
  };
}

function runtimeSelectionSourceKey(c: Context, edgeSecret: string | undefined): string {
  const presentedEdgeSecret = c.req.header(EDGE_SECRET_HEADER);
  const trustedEdge = Boolean(
    edgeSecret
    && presentedEdgeSecret
    && timingSafeTokenEquals(presentedEdgeSecret, edgeSecret),
  );
  if (trustedEdge) {
    const edgeSource = c.req.header('cf-connecting-ip')?.trim()
      ?? c.req.header('x-real-ip')?.trim()
      ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? 'unknown';
    return `edge:${edgeSource.slice(0, 128)}`;
  }

  // Forwarding headers are client-controlled unless the edge secret verifies.
  try {
    const directAddress = getConnInfo(c).remote.address;
    if (typeof directAddress === 'string' && isIP(directAddress) !== 0) {
      return `direct:${directAddress.slice(0, 128)}`;
    }
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn('[platform] Direct connection source unavailable:', err instanceof Error ? err.name : typeof err);
    }
  }
  return 'direct';
}

function computerAvailability(status: string): MatrixComputerAvailability {
  if (status === 'running') return 'available';
  if (status === 'provisioning' || status === 'recovering' || status === 'resizing') return 'starting';
  return 'unavailable';
}

function computerVersionLabel(imageVersion: string | null): MatrixComputerVersionLabel {
  if (imageVersion === 'stable' || imageVersion === 'dev' || imageVersion === 'canary' || imageVersion === 'beta') {
    return imageVersion;
  }
  const releaseDate = imageVersion?.match(RELEASE_DATE_PATTERN)?.[1];
  return releaseDate ? `v${releaseDate}` as MatrixComputerVersionLabel : 'Version pending';
}

function projectComputer(machine: UserRuntimeComputerRecord): MatrixComputer | null {
  const preview = isPreviewMachine(machine);
  const parsed = MatrixComputerSchema.safeParse({
    handle: machine.handle,
    runtimeSlot: machine.runtimeSlot,
    label: machine.runtimeSlot === 'primary'
      ? 'Main Computer'
      : preview
        ? 'Preview Computer'
        : 'Additional Computer',
    availability: computerAvailability(machine.status),
    kind: preview ? 'preview' : 'customer',
    versionLabel: computerVersionLabel(machine.imageVersion),
    gatewayPath: machine.runtimeSlot === 'primary'
      ? `/vm/${machine.handle}`
      : `/vm/${machine.handle}?runtime=${machine.runtimeSlot}`,
    capabilities: COMPUTER_CAPABILITIES,
  });
  return parsed.success ? parsed.data : null;
}

function controlPlaneHost(env: NodeJS.ProcessEnv): string | null {
  const configuredOrigin = env.MATRIX_API_ORIGIN?.trim();
  if (!configuredOrigin) return null;
  try {
    const url = new URL(configuredOrigin);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    const host = url.host.toLowerCase();
    if (isAppDomainHost(host) || isCodeDomainHost(host)) return null;
    return host;
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn('[platform] API origin validation failed:', typeof err);
    }
    return null;
  }
}

export function createComputerRoutes(opts: {
  db: PlatformDB;
  clerkAuth?: ClerkAuth;
  platformJwtSecret: string;
  legacyContainerRoutingEnabled: boolean;
  resolveIdentity?: typeof resolveAppDomainIdentity;
  resolveSyncIdentity?: typeof resolveSyncBearerIdentity;
  appEnv: NodeJS.ProcessEnv;
  applyNoStoreHeaders: (c: Context) => void;
  logRouteError: (route: string, err: unknown) => void;
  getGatewayUrlForHandle: (handle: string) => string;
}) {
  const routes = new Hono();
  const resolveIdentity = opts.resolveIdentity ?? resolveAppDomainIdentity;
  const resolveSyncIdentity = opts.resolveSyncIdentity ?? resolveSyncBearerIdentity;
  const sourceRateLimiter = createBoundedRateLimiter(RUNTIME_SELECTION_SOURCE_RATE_MAX);
  const principalRateLimiter = createBoundedRateLimiter(RUNTIME_SELECTION_PRINCIPAL_RATE_MAX);

  function tooManyRuntimeSelectionRequests(c: Context) {
    opts.applyNoStoreHeaders(c);
    c.header('Retry-After', '60');
    return c.json({ error: 'Too many requests' }, 429);
  }

  routes.get('/api/auth/computers', async (c) => {
    if (!opts.platformJwtSecret && !opts.clerkAuth) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Computers unavailable' }, 503);
    }

    let identity: AppDomainIdentity | null;
    try {
      identity = await resolveIdentity({
        authHeader: c.req.header('authorization'),
        cookieHeader: c.req.header('cookie'),
        clerkAuth: opts.clerkAuth,
        db: opts.db,
        platformJwtSecret: opts.platformJwtSecret,
        allowUnroutedClerkIdentity: true,
        clerkPrincipalOnly: true,
        legacyContainerRoutingEnabled: opts.legacyContainerRoutingEnabled,
        runtimeSlot: 'primary',
      });
    } catch (err: unknown) {
      opts.logRouteError('/api/auth/computers auth', err);
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Computers unavailable' }, 503);
    }
    if (!identity) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const requestedSelectedSlot = identity.source === 'auth' ? identity.runtimeSlot ?? null : null;
      const records = await listUserRuntimeComputersByClerkId(
        opts.db,
        identity.userId,
        COMPUTER_QUERY_LIMIT,
        requestedSelectedSlot ?? undefined,
      );
      const projected = records.flatMap((record) => {
        const computer = projectComputer(record);
        return computer ? [computer] : [];
      });
      const items = projected.slice(0, COMPUTER_LIST_LIMIT);
      const selectedSlot = requestedSelectedSlot !== null && items.some(
        (item) => item.runtimeSlot === requestedSelectedSlot,
      )
        ? requestedSelectedSlot
        : null;
      const payload = MatrixComputerListSchema.parse({
        items,
        selectedSlot,
        hasMore: projected.length > items.length,
        limit: COMPUTER_LIST_LIMIT,
      });
      opts.applyNoStoreHeaders(c);
      return c.json(payload);
    } catch (err: unknown) {
      opts.logRouteError('/api/auth/computers', err);
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Computers unavailable' }, 503);
    }
  });

  routes.post('/api/auth/runtime-selection', bodyLimit({
    maxSize: RUNTIME_SELECTION_BODY_LIMIT,
    onError: (c) => {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Request too large' }, 413);
    },
  }), async (c) => {
    const expectedHost = controlPlaneHost(opts.appEnv);
    if (!expectedHost) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Runtime selection unavailable' }, 503);
    }
    const requestHost = getTrustedSessionRouteHost(
      c.req.header('host'),
      c.req.header('x-forwarded-host'),
      c.req.header(EDGE_SECRET_HEADER),
      opts.appEnv.EDGE_ROUTER_SECRET,
    ).toLowerCase();
    if (requestHost !== expectedHost) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Not found' }, 404);
    }
    if (!opts.platformJwtSecret) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Runtime selection unavailable' }, 503);
    }
    if (!sourceRateLimiter.check(runtimeSelectionSourceKey(c, opts.appEnv.EDGE_ROUTER_SECRET))) {
      return tooManyRuntimeSelectionRequests(c);
    }
    const authHeader = c.req.header('authorization');

    let identity: Awaited<ReturnType<typeof resolveSyncBearerIdentity>>;
    try {
      identity = await resolveSyncIdentity({
        authorization: authHeader,
        db: opts.db,
        platformJwtSecret: opts.platformJwtSecret,
        legacyContainerRoutingEnabled: opts.legacyContainerRoutingEnabled,
      });
    } catch (err: unknown) {
      opts.logRouteError('/api/auth/runtime-selection auth', err);
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Runtime selection unavailable' }, 503);
    }
    const now = Math.floor(Date.now() / 1000);
    const remainingLifetime = identity ? identity.expiresAt - now : 0;
    if (!identity || remainingLifetime <= RUNTIME_SELECTION_EXPIRY_SKEW_SECONDS) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!principalRateLimiter.check(identity.userId)) {
      return tooManyRuntimeSelectionRequests(c);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'BodyLimitError') {
        opts.applyNoStoreHeaders(c);
        return c.json({ error: 'Request too large' }, 413);
      }
      if (!(err instanceof SyntaxError)) {
        opts.logRouteError('/api/auth/runtime-selection parse', err);
      }
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Invalid request' }, 400);
    }
    const parsedBody = RuntimeSelectionRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Invalid request' }, 400);
    }

    try {
      const machine = await getRunningUserMachineByClerkId(
        opts.db,
        identity.userId,
        parsedBody.data.slot,
      );
      if (!machine) {
        opts.applyNoStoreHeaders(c);
        return c.json({ error: 'Computer unavailable' }, 404);
      }
      const issued = await issueSyncJwt({
        secret: opts.platformJwtSecret,
        clerkUserId: identity.userId,
        handle: machine.handle,
        gatewayUrl: opts.getGatewayUrlForHandle(machine.handle),
        runtimeSlot: machine.runtimeSlot,
        expiresInSec: remainingLifetime,
        now,
      });
      const payload = RuntimeSelectionResponseSchema.parse({
        accessToken: issued.token,
        expiresAt: issued.expiresAt,
        handle: machine.handle,
        slot: machine.runtimeSlot,
      });
      opts.applyNoStoreHeaders(c);
      return c.json(payload);
    } catch (err: unknown) {
      opts.logRouteError('/api/auth/runtime-selection', err);
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Runtime selection unavailable' }, 503);
    }
  });

  return routes;
}
