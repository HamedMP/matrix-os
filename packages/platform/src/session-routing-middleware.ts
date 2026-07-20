import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type Dockerode from 'dockerode';
import type { Agent } from 'undici';
import { fonts, lightFg, palette, radii } from '@matrix-os/brand/tokens';
import type { Orchestrator } from './orchestrator.js';
import type { ClerkAuth } from './clerk-auth.js';
import {
  type PlatformDB,
  type UserMachineRecord,
  getAccessibleActiveUserMachineByClerkId,
  getActiveUserMachineByHandle,
  getContainer,
  getAccessibleRunningUserMachineByClerkId,
  getRunningUserMachineByHandle,
  updateLastActive,
} from './db.js';
import { canClerkUserAccessMachine } from './customer-vps-preview.js';
import { issueSyncJwt } from './sync-jwt.js';
import {
  buildCustomerVpsProxyUrl,
  type EntitlementAccessDecision,
} from './profile-routing.js';
import {
  buildPlatformVerificationToken,
  timingSafeTokenEquals,
} from './platform-token.js';
import {
  applyNoStoreResponseHeaders,
  sanitizeProxyResponseHeaders,
} from './proxy-headers.js';
import {
  buildBillingSetupPath,
  buildForwardedQueryString,
  buildPostAuthRedirectPath,
  getPlatformShellAssetUpstreamPath,
  getAuthShellOrigin,
  isAppDomainGatewayPath,
  isBillingSetupPath,
  isPlatformShellAssetNamespacePath,
  readRuntimeSlotSelection,
  shouldProxyAuthShellForUnroutedUser,
  shouldProxyShellForBillingGate,
} from './request-routing.js';
import { isAppDomainHost, isCodeDomainHost } from './ws-upgrade.js';
import { appOrigin } from './origins.js';
import {
  CLERK_SCRIPT_ORIGIN,
  getAuthPage,
  getNoContainerPage,
  getVpsBootPage,
} from './auth-pages.js';
import { appDomainServiceWorkerResponse } from './app-domain-service-worker.js';
import { isPostHogRelayPath, proxyPostHogRelay } from './posthog-relay.js';
import {
  CODE_SESSION_EXPIRES_IN_SEC,
  NATIVE_APP_SESSION_PROXY_HEADER,
  buildCodeSessionCookie,
} from './session-cookies.js';
import { HANDLE_PATTERN, describeError } from './platform-route-utils.js';
import {
  APP_ASSET_ROUTE_OMITTED_QUERY_PARAMS,
  EDGE_SECRET_HEADER,
  applyAppDomainRuntimeAssetCacheHeaders,
  applyCookieRoutedShellAssetCacheHeaders,
  applySandboxedAppAssetCorsHeaders,
  buildAppDomainProxyResponse,
  buildCodeDomainProxyHeaders,
  hasValidExplicitVmAppAssetToken,
  isAppDomainStaticAssetPath,
  isCodeDomainStaticAssetPath,
  isViteAppAssetPath,
  readAppAssetRouteToken,
  shouldForwardProxyHeader,
} from './session-routing-proxy.js';
import {
  type AppDomainIdentity,
  buildAppRouteCookie,
  buildShellRouteCookie,
  buildShellRuntimeSlotCookie,
  hasExplicitVmNativeAppStreamCapability,
  isNativeAppStreamPath,
  readAppDomainRouteCookie,
  readExplicitVmRoute,
  readMobileAppRouteCookie,
  readMobileAppSessionRoutingHandle,
  readShellRouteCookie,
  readShellRuntimeSlotCookie,
  resolveAppDomainIdentity,
  shouldMarkNativeAppSession,
} from './session-routing-identity.js';
import {
  buildPlatformUserProof,
  getTrustedSessionRouteHost,
} from './session-routing-websocket.js';
import {
  resolveContainerEndpoint,
} from './container-endpoint.js';
import { scopeExplicitVmAppSessionCookie } from './session-routing-cookie-rewrite.js';

export function shouldServeRuntimeManager(input: {
  isAppDomain: boolean;
  path: string;
  userId: string;
  identitySource?: AppDomainIdentity['source'];
}): boolean {
  return Boolean(
    input.isAppDomain &&
    input.userId &&
    input.path === '/runtime' &&
    input.identitySource !== 'mobile-session' &&
    input.identitySource !== 'static-route'
  );
}

interface CreateSessionRoutingMiddlewareOpts {
  db: PlatformDB;
  docker?: Dockerode;
  orchestrator: Orchestrator;
  clerkAuth?: ClerkAuth;
  appEnv: NodeJS.ProcessEnv;
  platformSecret: string;
  platformJwtSecret: string;
  legacyContainerRoutingEnabled: boolean;
  proxyTimeoutMs: number;
  authShellProxyTimeoutMs: number;
  codeServerPort: number;
  wsTokenExpiresInSec: number;
  containerProxyDispatcher: Agent;
  customerVpsProxyDispatcher: Agent;
  applyNoStoreHeaders: (c: Context) => void;
  getRuntimeEntitlementDecision: (env: NodeJS.ProcessEnv) => EntitlementAccessDecision;
  getRuntimeEntitlementDecisionForUser: (
    db: PlatformDB,
    clerkUserId: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<EntitlementAccessDecision>;
  getGatewayUrlForHandle: (handle: string) => string;
  logRouteError: (context: string, err: unknown) => void;
}

/**
 * Fetch a runtime response with a bounded header wait. Streaming responses can
 * release that timer once the upstream headers arrive so the signal does not
 * terminate a healthy, long-lived response body.
 */
export async function fetchRuntimeProxy(
  targetUrl: string,
  init: RequestInit,
  timeoutMs: number,
  releaseTimeoutAfterHeaders: boolean,
): Promise<Response> {
  if (!releaseTimeoutAfterHeaders) {
    return fetch(targetUrl, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(targetUrl, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function shouldReleaseRuntimeProxyTimeout(method: string, path: string): boolean {
  return method === 'GET' && path === '/api/files/media';
}

function logCodeDomainUpstreamFailure(opts: {
  handle: string;
  runtimeSlot?: string | null;
  publicIPv4?: string | null;
  path: string;
  status: number;
}): void {
  console.warn(
    `[platform] code-domain vps upstream 5xx handle=${opts.handle} runtimeSlot=${opts.runtimeSlot ?? 'unknown'} publicIPv4=${opts.publicIPv4 ?? 'unknown'} path=${JSON.stringify(opts.path)} status=${opts.status}`,
  );
}

function applyAuthPageHeaders(
  c: Context,
  scriptNonce: string,
  applyNoStoreHeaders: (c: Context) => void,
): void {
  applyNoStoreHeaders(c);
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    `frame-ancestors 'none'; script-src 'self' 'nonce-${scriptNonce}' ${CLERK_SCRIPT_ORIGIN} https://challenges.cloudflare.com; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'`,
  );
}

function runtimeShellUnavailableResponse(
  c: Context,
  applyNoStoreHeaders: (c: Context) => void,
): Response {
  applyNoStoreHeaders(c);
  c.header('Retry-After', '5');
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  );
  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix OS temporarily unavailable</title>
  <style>
    :root { --font-instrument: 'Instrument Sans'; color-scheme: dark; font-family: ${fonts.sans}; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: ${palette.deep}; color: ${lightFg}; }
    main { width: min(32rem, calc(100% - 3rem)); text-align: center; }
    h1 { margin: 0 0 0.75rem; font-size: clamp(1.5rem, 5vw, 2.25rem); }
    p { margin: 0 0 1.5rem; color: ${palette.cream}; line-height: 1.6; }
    a { display: inline-block; border: 1px solid ${palette.subtle}; border-radius: ${radii.pill}; padding: 0.7rem 1.1rem; color: inherit; text-decoration: none; }
    a:focus-visible { outline: 3px solid ${palette.ember}; outline-offset: 3px; }
  </style>
</head>
<body>
  <main>
    <h1>Matrix OS shell unavailable</h1>
    <p>The computer manager could not be loaded. Please try again in a moment.</p>
    <a href="/runtime">Try again</a>
  </main>
</body>
</html>`, 503);
}

export function createSessionRoutingMiddleware(opts: CreateSessionRoutingMiddlewareOpts): MiddlewareHandler {
  const {
    db,
    docker,
    orchestrator,
    clerkAuth,
    appEnv,
    platformSecret,
    platformJwtSecret,
    legacyContainerRoutingEnabled,
    proxyTimeoutMs,
    authShellProxyTimeoutMs,
    codeServerPort,
    wsTokenExpiresInSec,
    containerProxyDispatcher,
    customerVpsProxyDispatcher,
    applyNoStoreHeaders,
    getRuntimeEntitlementDecision,
    getRuntimeEntitlementDecisionForUser,
    getGatewayUrlForHandle,
    logRouteError,
  } = opts;

  async function proxyAuthShell(
    c: Context,
    host: string,
    proxyOpts: {
      assetRequest?: boolean;
      redirectToBillingOnFailure?: boolean;
      upstreamPath?: string;
    } = {},
  ): Promise<Response> {
    const upstream = new URL(c.req.url);
    const targetUrl = `${getAuthShellOrigin(appEnv)}${proxyOpts.upstreamPath ?? upstream.pathname}${upstream.search}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'host' && value) {
        headers.set(key, value);
      }
    }
    headers.set('host', new URL(getAuthShellOrigin(appEnv)).host);
    headers.set('x-forwarded-host', host);
    // The auth shell is a local plain-HTTP Next server. Forwarding "https" here
    // makes Next 16 attempt internal self-proxy requests to https://localhost:3200.
    headers.set('x-forwarded-proto', 'http');
    headers.set('accept-encoding', 'identity');
    headers.set('connection', 'close');

    try {
      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(authShellProxyTimeoutMs),
      });
      const responseHeaders = sanitizeProxyResponseHeaders(response.headers);
      applyNoStoreResponseHeaders(responseHeaders);
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (err: unknown) {
      logRouteError('app-domain auth-shell proxy', err);
      if (c.req.path === '/runtime') {
        return runtimeShellUnavailableResponse(c, applyNoStoreHeaders);
      }
      if (proxyOpts.assetRequest) {
        applyNoStoreHeaders(c);
        c.header('Retry-After', '5');
        return c.text('Matrix OS shell asset unavailable', 503);
      }
      if (proxyOpts.redirectToBillingOnFailure !== false && !isBillingSetupPath(c.req.url)) {
        return c.redirect(buildBillingSetupPath(c.req.url), 302);
      }
      const publishableKey = appEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
      if (!publishableKey) {
        return c.text('Matrix OS shell unavailable', 503);
      }
      applyNoStoreHeaders(c);
      const scriptNonce = randomBytes(16).toString('base64');
      applyAuthPageHeaders(c, scriptNonce, applyNoStoreHeaders);
      const authMode = c.req.path.startsWith('/sign-up') ? 'sign-up' : 'sign-in';
      return c.html(
        getAuthPage(publishableKey, authMode, scriptNonce, buildPostAuthRedirectPath(c.req.url), appOrigin(appEnv)),
        200,
      );
    }
  }

  async function issueWebSocketTokenResponse(
    c: Context,
    target: { clerkUserId: string; handle: string; runtimeSlot?: string },
  ): Promise<Response> {
    applyNoStoreHeaders(c);
    if (!platformJwtSecret) {
      return c.json({ error: 'WebSocket auth unavailable' }, 503);
    }
    const issued = await issueSyncJwt({
      secret: platformJwtSecret,
      clerkUserId: target.clerkUserId,
      handle: target.handle,
      gatewayUrl: getGatewayUrlForHandle(target.handle),
      runtimeSlot: target.runtimeSlot,
      expiresInSec: wsTokenExpiresInSec,
    });
    return c.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
    });
  }

  return async (c, next) => {
    const host = getTrustedSessionRouteHost(
      c.req.header('host'),
      c.req.header('x-forwarded-host'),
      c.req.header(EDGE_SECRET_HEADER),
      appEnv.EDGE_ROUTER_SECRET,
    );
    const isAppDomain = isAppDomainHost(host);
    const isCodeDomain = isCodeDomainHost(host);
    if (!isAppDomain && !isCodeDomain) return next();

    // Device-flow paths are served directly by the platform's auth-routes.ts
    // (registered above). In normal dispatch they never reach this middleware,
    // but we short-circuit explicitly so a misconfigured PLATFORM_JWT_SECRET or
    // a future refactor can't accidentally proxy them into a user container.
    const reqPath = c.req.path;
    if (isAppDomain && reqPath === '/service-worker.js') {
      return appDomainServiceWorkerResponse();
    }
    if (isAppDomain && isPlatformShellAssetNamespacePath(reqPath)) {
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        applyNoStoreHeaders(c);
        c.header('Allow', 'GET, HEAD');
        return c.text('Method Not Allowed', 405);
      }
      const upstreamPath = getPlatformShellAssetUpstreamPath(reqPath);
      if (!upstreamPath) {
        applyNoStoreHeaders(c);
        return c.text('Not Found', 404);
      }
      return proxyAuthShell(c, host, {
        assetRequest: true,
        redirectToBillingOnFailure: false,
        upstreamPath,
      });
    }
    if (isAppDomain && isPostHogRelayPath(reqPath)) {
      return proxyPostHogRelay(c, { logRouteError: logRouteError });
    }
    if (isAppDomain && (
      reqPath === '/auth/device' ||
      reqPath.startsWith('/auth/device/') ||
      reqPath.startsWith('/api/auth/device/') ||
      reqPath === '/api/auth/app-session' ||
      reqPath === '/api/auth/computers' ||
      reqPath === '/api/auth/provision-runtime' ||
      reqPath === '/api/journey' ||
      reqPath === '/api/journey/retry-provision'
    )) {
      return next();
    }
    if ((isAppDomain || isCodeDomain) && (reqPath === '/vps' || reqPath.startsWith('/vps/'))) {
      return next();
    }
    if ((isAppDomain || isCodeDomain) && reqPath.startsWith('/internal/containers/')) {
      return next();
    }
    const isPublicIntegrationPath =
      reqPath === '/api/integrations/available' ||
      reqPath.startsWith('/api/integrations/webhook/');
    const isIntegrationPath =
      reqPath === '/api/integrations' || reqPath.startsWith('/api/integrations/');
    if (isAppDomain && isPublicIntegrationPath) {
      return next();
    }
    if (isAppDomain && reqPath === '/voice/webhook/twilio') {
      const webhookUrl = new URL(c.req.url);
      const handle = webhookUrl.searchParams.get('handle') ?? '';
      if (!HANDLE_PATTERN.test(handle)) {
        return c.json({ error: 'Invalid handle' }, 400);
      }

      const runningMachine = await getRunningUserMachineByHandle(db, handle);
      if (!runningMachine) {
        return c.json({ error: 'VPS unavailable' }, 404);
      }

      const qs = buildForwardedQueryString(c.req.url, APP_ASSET_ROUTE_OMITTED_QUERY_PARAMS);
      const targetUrl = buildCustomerVpsProxyUrl(runningMachine, reqPath, qs);
      if (!targetUrl) {
        return c.json({ error: 'VPS unreachable' }, 502);
      }

      const headers = new Headers();
      for (const [key, value] of Object.entries(c.req.header())) {
        if (shouldForwardProxyHeader(key, value)) {
          headers.set(key, value);
        }
      }
      headers.set('host', 'app.matrix-os.com');
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');
      headers.set('accept-encoding', 'identity');
      headers.set('connection', 'close');
      if (platformSecret) {
        headers.set('authorization', `Bearer ${buildPlatformVerificationToken(handle, platformSecret)}`);
      }

      try {
        const upstream = await fetch(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(proxyTimeoutMs),
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
          dispatcher: customerVpsProxyDispatcher,
        } as RequestInit & { dispatcher: Agent });

        return new Response(upstream.body, {
          status: upstream.status,
          headers: sanitizeProxyResponseHeaders(upstream.headers),
        });
      } catch (err: unknown) {
        logRouteError('app-domain voice webhook proxy', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
    }

    const authHeader = c.req.header('authorization');
    const cookieHeader = c.req.header('cookie');
    const path = c.req.path;
    const explicitVmRoute = isAppDomain ? readExplicitVmRoute(path) : null;
    const explicitVmRouteHasValidAppAssetToken = Boolean(
      explicitVmRoute &&
      hasValidExplicitVmAppAssetToken({
        method: c.req.method,
        rawUrl: c.req.url,
        route: explicitVmRoute,
        platformSecret,
      }),
    );
    const explicitVmRouteHasNativeAppStreamCapability = Boolean(
      explicitVmRoute && hasExplicitVmNativeAppStreamCapability(c.req.method, explicitVmRoute),
    );
    const explicitVmRouteHasCredentiallessCapability =
      explicitVmRouteHasValidAppAssetToken || explicitVmRouteHasNativeAppStreamCapability;
    if (
      explicitVmRoute
      && isNativeAppStreamPath(explicitVmRoute.upstreamPath)
      && !explicitVmRouteHasNativeAppStreamCapability
    ) {
      applyNoStoreHeaders(c);
      return c.text('Unauthorized', 401);
    }
    const runtimeSelection = readRuntimeSlotSelection(c.req.url);
    const cookieRuntimeSlot = isAppDomain
      ? readShellRuntimeSlotCookie(path, cookieHeader)
      : null;
    const requestRuntimeSlot = explicitVmRoute?.runtimeSlot ?? (
      runtimeSelection.source === 'query'
        ? runtimeSelection.slot
        : cookieRuntimeSlot ?? runtimeSelection.slot
    );

    const isGatewayPath = isAppDomain && isAppDomainGatewayPath(path);
    const allowAuthShellUnroutedIdentity = shouldProxyAuthShellForUnroutedUser({
      isAppDomain,
      method: c.req.method,
      path,
    }) && (!legacyContainerRoutingEnabled || path === '/runtime');
    const publishableKey = appEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    const authMode = path.startsWith('/sign-up') ? 'sign-up' : 'sign-in';
    const requestedRouteHandle = !explicitVmRoute && isAppDomain
      ? readAppDomainRouteCookie(path, cookieHeader)
      : null;

    let identity = await resolveAppDomainIdentity({
      authHeader,
      cookieHeader,
      clerkAuth,
      db,
      platformJwtSecret,
      legacyContainerRoutingEnabled,
      allowUnroutedClerkIdentity: Boolean(explicitVmRoute) || allowAuthShellUnroutedIdentity,
      requestedHandle: requestedRouteHandle,
      runtimeSlot: requestRuntimeSlot,
    });
    if (!identity && isAppDomain) {
      const mobileSessionHandle =
        readMobileAppSessionRoutingHandle(path, c.req.url) ??
        readMobileAppRouteCookie(path, cookieHeader);
      if (mobileSessionHandle) {
        identity = {
          handle: mobileSessionHandle,
          userId: '',
          source: 'mobile-session',
        };
      }
    }
    if (
      !identity &&
      explicitVmRoute &&
      explicitVmRouteHasCredentiallessCapability
    ) {
      identity = {
        handle: explicitVmRoute.handle,
        userId: '',
        source: 'static-route',
      };
    }
    if (!identity && isAppDomain && isAppDomainStaticAssetPath(path)) {
      const shellRouteHandle = readShellRouteCookie(path, cookieHeader);
      if (shellRouteHandle) {
        identity = {
          handle: shellRouteHandle,
          userId: '',
          source: 'static-route',
        };
      }
    }
    const isCookieRoutedShellAsset = Boolean(
      identity &&
      requestedRouteHandle &&
      identity.handle === requestedRouteHandle &&
      isAppDomain &&
      isAppDomainStaticAssetPath(path),
    );
    const shouldPersistShellRoute = Boolean(
      isAppDomain &&
      identity &&
      identity.source !== 'static-route' &&
      (
        requestedRouteHandle ||
        (!isGatewayPath && !isAppDomainStaticAssetPath(path))
      ),
    );

    // No session/JWT -- serve Clerk auth directly from the platform.
    if (!identity) {
      console.log(`[${isCodeDomain ? 'code' : 'app'}] no token path=${path}`);
      if (isAppDomain && allowAuthShellUnroutedIdentity) {
        return proxyAuthShell(c, host, { redirectToBillingOnFailure: false });
      }
      if (isCodeDomain && isCodeDomainStaticAssetPath(path)) {
        applyNoStoreHeaders(c);
        return c.text('Unauthorized', 401);
      }
      if (isAppDomain && explicitVmRoute && isViteAppAssetPath(explicitVmRoute.upstreamPath)) {
        applyNoStoreHeaders(c);
        return c.text('Unauthorized', 401);
      }
      if (isAppDomain && isAppDomainStaticAssetPath(path)) {
        applyNoStoreHeaders(c);
        return c.text('Unauthorized', 401);
      }
      if (isGatewayPath && requestedRouteHandle) {
        applyNoStoreHeaders(c);
        return c.json({ error: 'Matrix computer unavailable', code: 'machine_unavailable' }, 410);
      }
      if (isGatewayPath) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!publishableKey || !clerkAuth) {
        return c.text('Clerk publishable key not configured', 500);
      }
      const scriptNonce = randomBytes(16).toString('base64');
      applyAuthPageHeaders(c, scriptNonce, applyNoStoreHeaders);
      return c.html(getAuthPage(publishableKey, authMode, scriptNonce, buildPostAuthRedirectPath(c.req.url), appOrigin(appEnv)));
    }

    console.log(`[${isCodeDomain ? 'code' : 'app'}] verified request path=${path}`);
    if (isAppDomain && path === '/vm') {
      return c.redirect('/runtime');
    }
    if (isAppDomain && path.startsWith('/vm/') && !explicitVmRoute) {
      return c.text('Invalid Matrix OS computer', 400);
    }
    if (isAppDomain && explicitVmRoute) {
      if ((!identity.userId || identity.source === 'mobile-session' || identity.source === 'static-route') && !explicitVmRouteHasCredentiallessCapability) {
        applyNoStoreHeaders(c);
        return c.text('Unauthorized', 401);
      }
      const machine = await getActiveUserMachineByHandle(
        db,
        explicitVmRoute.handle,
        explicitVmRoute.runtimeSlot ?? (
          runtimeSelection.source === 'query' ? requestRuntimeSlot : undefined
        ),
      );
      if (!machine || (identity.userId && !canClerkUserAccessMachine(machine, identity.userId))) {
        applyNoStoreHeaders(c);
        return c.text('Matrix OS computer unavailable', 404);
      }
      const entitlement = await getRuntimeEntitlementDecisionForUser(db, machine.clerkUserId, appEnv);
      if (
        !entitlement.runtimeProxyAllowed &&
        !shouldProxyShellForBillingGate({
          isAppDomain,
          method: c.req.method,
          upstreamPath: explicitVmRoute.upstreamPath,
        })
      ) {
        applyNoStoreHeaders(c);
        return c.json({ error: 'Paid beta access required' }, 402);
      }
      if (machine.status !== 'running') {
        if (isGatewayPath) {
          applyNoStoreHeaders(c);
          return c.json({
            error: 'VPS provisioning',
            status: machine.status,
          }, 503);
        }
        applyNoStoreHeaders(c);
        return c.html(getVpsBootPage({ status: machine.status }), 503);
      }
      if (explicitVmRoute.upstreamPath === '/api/auth/ws-token') {
        return issueWebSocketTokenResponse(c, {
          clerkUserId: machine.clerkUserId,
          handle: machine.handle,
          runtimeSlot: machine.runtimeSlot,
        });
      }
      const qs = buildForwardedQueryString(c.req.url, APP_ASSET_ROUTE_OMITTED_QUERY_PARAMS);
      const targetUrl = buildCustomerVpsProxyUrl(machine, explicitVmRoute.upstreamPath, qs);
      if (!targetUrl) {
        return c.json({ error: 'VPS unreachable' }, 502);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(c.req.header())) {
        if (shouldForwardProxyHeader(key, value)) {
          headers.set(key, value);
        }
      }
      const rawCookie = c.req.header('cookie');
      if (rawCookie) {
        const forwarded = rawCookie
          .split(';')
          .map((p) => p.trim())
          .filter((p) => p.startsWith('matrix_app_session__'))
          .join('; ');
        if (forwarded) headers.set('cookie', forwarded);
      }
      headers.set('host', `${machine.handle}.matrix-os.com`);
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');
      headers.set('accept-encoding', 'identity');
      headers.set('connection', 'close');
      // Capability-only requests must not inherit the platform's internal
      // runtime credential. The gateway authorizes this exact stream path by
      // validating its opaque token against the live native-app session.
      if (platformSecret && !explicitVmRouteHasNativeAppStreamCapability) {
        headers.set('authorization', `Bearer ${buildPlatformVerificationToken(machine.handle, platformSecret)}`);
        if (identity.userId) {
          headers.set('x-platform-user-id', identity.userId);
          headers.set('x-platform-verified', buildPlatformUserProof(machine.handle, identity.userId, platformSecret));
        }
      }
      if (shouldMarkNativeAppSession(identity, authHeader, cookieHeader, platformJwtSecret)) {
        headers.set(NATIVE_APP_SESSION_PROXY_HEADER, '1');
      }

      try {
        const upstream = await fetchRuntimeProxy(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
          dispatcher: customerVpsProxyDispatcher,
        } as RequestInit & { dispatcher: Agent }, proxyTimeoutMs,
        shouldReleaseRuntimeProxyTimeout(c.req.method, explicitVmRoute.upstreamPath));

        const responseHeaders = sanitizeProxyResponseHeaders(upstream.headers);
        scopeExplicitVmAppSessionCookie(responseHeaders, explicitVmRoute);
        applySandboxedAppAssetCorsHeaders(responseHeaders, explicitVmRoute.upstreamPath, c.req.header('origin'));
        applyAppDomainRuntimeAssetCacheHeaders(responseHeaders, explicitVmRoute.upstreamPath, c.req.url);
        responseHeaders.append('set-cookie', buildShellRouteCookie(machine.handle));
        responseHeaders.append('set-cookie', buildShellRuntimeSlotCookie(machine.runtimeSlot));
        return await buildAppDomainProxyResponse({
          upstream,
          responseHeaders,
          path: explicitVmRoute.upstreamPath,
          handle: machine.handle,
          runtimeSlot: machine.runtimeSlot,
          platformSecret,
          assetRouteToken: readAppAssetRouteToken(c.req.url),
        });
      } catch (err: unknown) {
        logRouteError('app-domain explicit vps proxy', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
    }

    if (isAppDomain && isIntegrationPath) {
      c.set('platformUserId', identity.userId);
      c.set('platformHandle', identity.handle);
      return next();
    }

    if (isAppDomain && path === '/api/auth/ws-token') {
      return issueWebSocketTokenResponse(c, {
        clerkUserId: identity.userId,
        handle: identity.handle,
        runtimeSlot: identity.runtimeSlot ?? requestRuntimeSlot,
      });
    }

    const serveRuntimeManager = shouldServeRuntimeManager({
      isAppDomain,
      path,
      userId: identity.userId,
      identitySource: identity.source,
    });
    if (serveRuntimeManager) {
      return proxyAuthShell(c, host, { redirectToBillingOnFailure: false });
    }

    let runtimeSlot = identity.runtimeSlot ?? requestRuntimeSlot;
    let requestedActiveMachine: UserMachineRecord | undefined;
    let runningMachine = identity.userId
      ? await getAccessibleRunningUserMachineByClerkId(db, identity.userId, runtimeSlot)
      : await getRunningUserMachineByHandle(db, identity.handle);
    if (!runningMachine && identity.userId) {
      requestedActiveMachine = await getAccessibleActiveUserMachineByClerkId(db, identity.userId, runtimeSlot);
      if (!requestedActiveMachine) {
        const handleMachine = await getRunningUserMachineByHandle(db, identity.handle);
        if (handleMachine && canClerkUserAccessMachine(handleMachine, identity.userId)) {
          runningMachine = handleMachine;
        }
      }
    }
    if (runningMachine) {
      runtimeSlot = runningMachine.runtimeSlot;
    }
    const entitlement = runningMachine
      ? await getRuntimeEntitlementDecisionForUser(db, runningMachine.clerkUserId, appEnv)
      : requestedActiveMachine
        ? await getRuntimeEntitlementDecisionForUser(db, requestedActiveMachine.clerkUserId, appEnv)
        : getRuntimeEntitlementDecision(appEnv);
    if (runningMachine) {
      const qs = buildForwardedQueryString(c.req.url, APP_ASSET_ROUTE_OMITTED_QUERY_PARAMS);
      if (
        !entitlement.runtimeProxyAllowed &&
        !shouldProxyShellForBillingGate({
          isAppDomain,
          method: c.req.method,
          upstreamPath: path,
        })
      ) {
        applyNoStoreHeaders(c);
        return c.json({ error: 'Paid beta access required' }, 402);
      }
      const targetUrl = buildCustomerVpsProxyUrl(runningMachine, path, qs);
      if (!targetUrl) {
        return c.json({ error: 'VPS unreachable' }, 502);
      }
      const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob();
      const headers = isCodeDomain
        ? buildCodeDomainProxyHeaders(
            c.req.header(),
            host,
            platformSecret ? buildPlatformVerificationToken(runningMachine.handle, platformSecret) : undefined,
          )
        : new Headers();
      if (!isCodeDomain) {
        for (const [key, value] of Object.entries(c.req.header())) {
          if (shouldForwardProxyHeader(key, value)) {
            headers.set(key, value);
          }
        }
        const rawCookie = c.req.header('cookie');
        if (rawCookie) {
          const forwarded = rawCookie
            .split(';')
            .map((p) => p.trim())
            .filter((p) => p.startsWith('matrix_app_session__'))
            .join('; ');
          if (forwarded) headers.set('cookie', forwarded);
        }
        headers.set('host', `${runningMachine.handle}.matrix-os.com`);
        headers.set('x-forwarded-host', host);
        headers.set('x-forwarded-proto', 'https');
        headers.set('accept-encoding', 'identity');
        headers.set('connection', 'close');
      }
      if (platformSecret) {
        headers.set('authorization', `Bearer ${buildPlatformVerificationToken(runningMachine.handle, platformSecret)}`);
        const platformUserId =
          identity.source === 'static-route' ? runningMachine.clerkUserId : identity.userId;
        if (platformUserId) {
          headers.set('x-platform-user-id', platformUserId);
          if (identity.source !== 'mobile-session' && identity.source !== 'static-route') {
            headers.set('x-platform-verified', buildPlatformUserProof(runningMachine.handle, platformUserId, platformSecret));
          }
        }
      }
      if (isAppDomain && shouldMarkNativeAppSession(identity, authHeader, cookieHeader, platformJwtSecret)) {
        headers.set(NATIVE_APP_SESSION_PROXY_HEADER, '1');
      }

      try {
        const upstream = await fetchRuntimeProxy(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          body,
          dispatcher: customerVpsProxyDispatcher,
        } as RequestInit & { dispatcher: Agent }, proxyTimeoutMs,
        shouldReleaseRuntimeProxyTimeout(c.req.method, path));
        if (isCodeDomain && upstream.status >= 500) {
          logCodeDomainUpstreamFailure({
            handle: runningMachine.handle,
            runtimeSlot: runningMachine.runtimeSlot,
            publicIPv4: runningMachine.publicIPv4,
            path,
            status: upstream.status,
          });
        }

        const responseHeaders = sanitizeProxyResponseHeaders(upstream.headers);
        applySandboxedAppAssetCorsHeaders(responseHeaders, path, c.req.header('origin'));
        if ((identity.source === 'static-route' || isCookieRoutedShellAsset) && isAppDomainStaticAssetPath(path)) {
          applyCookieRoutedShellAssetCacheHeaders(responseHeaders);
        }
        applyAppDomainRuntimeAssetCacheHeaders(responseHeaders, path, c.req.url);
        if (identity.source === 'mobile-session') {
          const routeCookie = buildAppRouteCookie(runningMachine.handle, path);
          if (routeCookie) responseHeaders.append('set-cookie', routeCookie);
        }
        if (shouldPersistShellRoute) {
          responseHeaders.append('set-cookie', buildShellRouteCookie(runningMachine.handle));
          responseHeaders.append('set-cookie', buildShellRuntimeSlotCookie(runningMachine.runtimeSlot));
        }
        if (isCodeDomain && platformJwtSecret) {
          const issued = await issueSyncJwt({
            secret: platformJwtSecret,
            clerkUserId: identity.userId,
            handle: runningMachine.handle,
            gatewayUrl: 'https://code.matrix-os.com',
            runtimeSlot,
            expiresInSec: CODE_SESSION_EXPIRES_IN_SEC,
          });
          responseHeaders.append('set-cookie', buildCodeSessionCookie(issued.token));
        }

        if (isAppDomain) {
          return await buildAppDomainProxyResponse({
            upstream,
            responseHeaders,
            path,
            handle: runningMachine.handle,
            runtimeSlot: runningMachine.runtimeSlot,
            platformSecret,
            assetRouteToken: readAppAssetRouteToken(c.req.url),
          });
        }
        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch (err: unknown) {
        logRouteError(isCodeDomain ? 'code-domain vps proxy' : 'app-domain vps proxy', err);
        return c.json({ error: 'VPS unreachable' }, 502);
      }
    }

    const activeMachine = requestedActiveMachine ?? (identity.userId
      ? await getAccessibleActiveUserMachineByClerkId(db, identity.userId, runtimeSlot)
      : await getActiveUserMachineByHandle(db, identity.handle));
    if (activeMachine) {
      if (
        !entitlement.runtimeProxyAllowed &&
        !shouldProxyShellForBillingGate({
          isAppDomain,
          method: c.req.method,
          upstreamPath: path,
        })
      ) {
        applyNoStoreHeaders(c);
        return c.json({ error: 'Paid beta access required' }, 402);
      }
      if (isCodeDomain || isGatewayPath) {
        applyNoStoreHeaders(c);
        return c.json({
          error: 'VPS provisioning',
          status: activeMachine.status,
        }, 503);
      }
      applyNoStoreHeaders(c);
      return c.html(getVpsBootPage({ status: activeMachine.status }), 503);
    }

    if (!legacyContainerRoutingEnabled) {
      applyNoStoreHeaders(c);
      if (isCodeDomain || isGatewayPath) {
        return c.json({ error: 'Matrix computer unavailable' }, 503);
      }
      if (allowAuthShellUnroutedIdentity && identity.handle === '') {
        return proxyAuthShell(c, host);
      }
      return c.html(getNoContainerPage(), 503);
    }

    const record = await getContainer(db, identity.handle);
    if (!record) return c.html(getNoContainerPage());

    if (
      !entitlement.runtimeProxyAllowed &&
      !shouldProxyShellForBillingGate({
        isAppDomain,
        method: c.req.method,
        upstreamPath: path,
      })
    ) {
      applyNoStoreHeaders(c);
      return c.json({ error: 'Paid beta access required' }, 402);
    }

    if (record.status === 'stopped') {
      try {
        await orchestrator.start(record.handle);
      } catch (err: unknown) {
        logRouteError('app-domain container start', err);
        return c.json({ error: 'Failed to wake container' }, 503);
      }
    }

    await updateLastActive(db, record.handle);

    const qs = buildForwardedQueryString(c.req.url, APP_ASSET_ROUTE_OMITTED_QUERY_PARAMS);
    const targetPort = isCodeDomain ? codeServerPort : (isGatewayPath || path === '/apps' || path.startsWith('/apps/')) ? 4000 : 3000;
    const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob();
    const headers = isCodeDomain
      ? buildCodeDomainProxyHeaders(
          c.req.header(),
          host,
          platformSecret ? buildPlatformVerificationToken(record.handle, platformSecret) : undefined,
        )
      : new Headers();
    if (!isCodeDomain) {
      for (const [key, value] of Object.entries(c.req.header())) {
        if (shouldForwardProxyHeader(key, value)) {
          headers.set(key, value);
        }
      }
    }
    // Forward only the app-session cookies (spec 063). Clerk and other
    // cookies are stripped because gateway auth goes via the bearer token
    // set below; forwarding them would leak the user's Clerk session into
    // the container process.
    if (!isCodeDomain) {
      const rawCookie = c.req.header('cookie');
      if (rawCookie) {
        const forwarded = rawCookie
          .split(';')
          .map((p) => p.trim())
          .filter((p) => p.startsWith('matrix_app_session__'))
          .join('; ');
        if (forwarded) headers.set('cookie', forwarded);
      }
      headers.set('x-forwarded-host', host);
      headers.set('x-forwarded-proto', 'https');
      headers.set('accept-encoding', 'identity');
      headers.set('connection', 'close');
    }
    if (platformSecret && isAppDomain) {
      headers.set('authorization', `Bearer ${buildPlatformVerificationToken(record.handle, platformSecret)}`);
      const platformUserId =
        identity.source === 'static-route' ? record.clerkUserId : identity.userId;
      if (platformUserId) {
        headers.set('x-platform-user-id', platformUserId);
        if (identity.source !== 'mobile-session' && identity.source !== 'static-route') {
          headers.set('x-platform-verified', buildPlatformUserProof(record.handle, platformUserId, platformSecret));
        }
      }
    }
    if (isAppDomain && shouldMarkNativeAppSession(identity, authHeader, cookieHeader, platformJwtSecret)) {
      headers.set(NATIVE_APP_SESSION_PROXY_HEADER, '1');
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const endpoint = await resolveContainerEndpoint(docker, db, record.handle, record.containerId);
      if (!endpoint) {
        console.warn(
          `[platform] session-domain proxy unresolved handle=${record.handle} attempt=${attempt + 1} path=${path} targetPort=${targetPort}`,
        );
        return c.json({ error: 'Container unreachable' }, 502);
      }

      const targetUrl = `http://${endpoint.host}:${targetPort}${path}${qs}`;
      try {
        const upstream = await fetchRuntimeProxy(targetUrl, {
          method: c.req.method,
          headers,
          redirect: 'manual',
          body,
          dispatcher: containerProxyDispatcher,
        } as RequestInit & { dispatcher: Agent }, proxyTimeoutMs,
        shouldReleaseRuntimeProxyTimeout(c.req.method, path));

        const responseHeaders = sanitizeProxyResponseHeaders(upstream.headers);
        applySandboxedAppAssetCorsHeaders(responseHeaders, path, c.req.header('origin'));
        if ((identity.source === 'static-route' || isCookieRoutedShellAsset) && isAppDomainStaticAssetPath(path)) {
          applyCookieRoutedShellAssetCacheHeaders(responseHeaders);
        }
        applyAppDomainRuntimeAssetCacheHeaders(responseHeaders, path, c.req.url);
        if (identity.source === 'mobile-session') {
          const routeCookie = buildAppRouteCookie(record.handle, path);
          if (routeCookie) responseHeaders.append('set-cookie', routeCookie);
        }
        if (shouldPersistShellRoute) {
          responseHeaders.append('set-cookie', buildShellRouteCookie(record.handle));
          responseHeaders.append('set-cookie', buildShellRuntimeSlotCookie('primary'));
        }
        if (isCodeDomain && platformJwtSecret) {
          const issued = await issueSyncJwt({
            secret: platformJwtSecret,
            clerkUserId: identity.userId,
            handle: record.handle,
            gatewayUrl: 'https://code.matrix-os.com',
            expiresInSec: CODE_SESSION_EXPIRES_IN_SEC,
          });
          responseHeaders.append('set-cookie', buildCodeSessionCookie(issued.token));
        }

        if (isAppDomain) {
          return await buildAppDomainProxyResponse({
            upstream,
            responseHeaders,
            path,
            handle: record.handle,
            runtimeSlot: 'primary',
            platformSecret,
            assetRouteToken: readAppAssetRouteToken(c.req.url),
          });
        }
        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch (err: unknown) {
        lastErr = err;
        const routeName = isCodeDomain ? 'code-domain' : 'app-domain';
        console.warn(
          `[platform] ${routeName} proxy retry attempt=${attempt + 1} handle=${record.handle} target=${targetUrl} source=${endpoint.source} containerId=${endpoint.containerId ?? 'null'} error=${describeError(err)}`,
        );
      }
    }

    logRouteError(isCodeDomain ? 'code-domain proxy' : 'app-domain proxy', lastErr);
    return c.json({ error: 'Container unreachable' }, 502);
  };
}
