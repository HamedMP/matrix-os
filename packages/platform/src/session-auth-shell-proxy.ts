/**
 * Auth-shell reverse proxy handler.
 *
 * Extracted from ./session-routing-middleware.ts (Phase 1-A4). Pure move: no logic changes.
 */

import type { Context } from 'hono';
import { randomBytes } from 'node:crypto';
import type { CreateSessionRoutingMiddlewareOpts } from './session-routing-middleware.js';
import {
  buildBillingSetupPath,
  buildPostAuthRedirectPath,
  getAuthShellOrigin,
  isBillingSetupPath,
  isSignupBillingHandoff,
} from './request-routing.js';
import {
  applyNoStoreResponseHeaders,
  sanitizeProxyResponseHeaders,
} from './proxy-headers.js';
import { getSignupBillingHandoffPage } from './signup-billing-handoff-page.js';
import { appOrigin } from './origins.js';
import { getAuthPage } from './auth-pages.js';
import {
  applyAuthPageHeaders,
  isPlatformRuntimeShellPath,
  platformRuntimeShellUnavailableResponse,
} from './session-routing-helpers.js';

export interface AuthShellProxyDeps {
  appEnv: CreateSessionRoutingMiddlewareOpts['appEnv'];
  authShellProxyTimeoutMs: number;
  logRouteError: CreateSessionRoutingMiddlewareOpts['logRouteError'];
  applyNoStoreHeaders: CreateSessionRoutingMiddlewareOpts['applyNoStoreHeaders'];
}

export function createAuthShellProxy(deps: AuthShellProxyDeps) {
  const {
    appEnv,
    authShellProxyTimeoutMs,
    logRouteError,
    applyNoStoreHeaders,
  } = deps;
  async function proxyAuthShell(
    c: Context,
    host: string,
    proxyOpts: {
      assetRequest?: boolean;
      preserveUpstreamCacheHeaders?: boolean;
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
      if (!proxyOpts.preserveUpstreamCacheHeaders) {
        applyNoStoreResponseHeaders(responseHeaders);
      }
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (err: unknown) {
      logRouteError('app-domain auth-shell proxy', err);
      if (isPlatformRuntimeShellPath(c.req.path)) {
        return platformRuntimeShellUnavailableResponse(c, applyNoStoreHeaders);
      }
      if (proxyOpts.assetRequest) {
        applyNoStoreHeaders(c);
        c.header('Retry-After', '5');
        return c.text('Matrix OS shell asset unavailable', 503);
      }
      if (isSignupBillingHandoff(c.req.url)) {
        const publishableKey = appEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
        if (!publishableKey) {
          applyNoStoreHeaders(c);
          return c.text('Matrix OS shell unavailable', 503);
        }
        const scriptNonce = randomBytes(16).toString('base64');
        applyAuthPageHeaders(c, scriptNonce, applyNoStoreHeaders);
        const requestUrl = new URL(c.req.url);
        return c.html(getSignupBillingHandoffPage({
          publishableKey,
          scriptNonce,
          redirectTarget: `${requestUrl.pathname}${requestUrl.search}`,
        }));
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
  return { proxyAuthShell };
}
