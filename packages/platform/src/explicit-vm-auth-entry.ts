import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { CLERK_SCRIPT_ORIGIN, getAuthPage } from './auth-pages.js';
import { appOrigin, resolveReturnPath } from './origins.js';
import { readRuntimeSlotSelection, shouldProxyAuthShellForUnroutedUser, shouldProxyShellForBillingGate } from './request-routing.js';
import { type ExplicitVmRoute, readExplicitVmRoute } from './session-routing-identity.js';
import { isAppDomainStaticAssetPath } from './session-routing-proxy.js';

const MAX_RETURN_TARGET_LENGTH = 2_048; // Existing app-session request limit.
const AUTH_QUERY_FIELDS = [
  'auth', 'authorization', 'jwt', 'code', 'state', 'nonce',
  'proof', 'signature', 'key', 'apikey', 'credential', 'credentials', 'password',
  'redirecturl', 'redirecturi', 'redirectsig', 'devicereturn',
  'codeverifier', 'codechallenge', 'codechallengemethod',
] as const;

function isAuthQueryField(name: string): boolean {
  // URLSearchParams decoded the field name once. Canonicalization also handles
  // camelCase, separators and case variants without changing safe query bytes.
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return AUTH_QUERY_FIELDS.some((field) => key === field)
    || key.startsWith('clerk') || key.startsWith('pkce')
    || /token|secret|session|password|credential/.test(key);
}

/** A VM prefix must not hide runtime APIs/assets from document classification. */
function isDocumentRequest(c: Context, route: ExplicitVmRoute): boolean {
  const accept = c.req.header('accept');
  return (c.req.method === 'GET' || c.req.method === 'HEAD')
    && (!accept || accept.includes('text/html') || accept.includes('application/xhtml+xml') || accept === '*/*')
    && shouldProxyAuthShellForUnroutedUser({ isAppDomain: true, method: c.req.method, path: route.upstreamPath })
    && shouldProxyShellForBillingGate({ isAppDomain: true, method: c.req.method, upstreamPath: route.upstreamPath })
    && !isAppDomainStaticAssetPath(route.upstreamPath);
}

/** Only a validated relative VM path is handed to Clerk; query values are never destinations. */
export function explicitVmAuthReturnTarget(rawUrl: string): string | null {
  try {
    // URL normalizes dot segments before resolveReturnPath can reject them.
    const rawPath = rawUrl.split(/[?#]/, 1)[0];
    if (rawPath.includes('\\') || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(rawPath)) return null;
    const url = new URL(rawUrl);
    const original = `${url.pathname}${url.search}`;
    if (original.length > MAX_RETURN_TARGET_LENGTH || !readExplicitVmRoute(url.pathname)) return null;
    // Retain routing query bytes/order/repeated keys; omit recognized auth/session fields.
    const query = url.search.slice(1).split('&').filter((part) => {
      const name = new URLSearchParams(part).keys().next().value;
      return name !== undefined && !isAuthQueryField(name);
    }).join('&');
    const target = `${url.pathname}${query ? `?${query}` : ''}`;
    return resolveReturnPath(target) === target ? target : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function applyAuthPageHeaders(
  c: Context,
  scriptNonce: string,
  applyNoStoreHeaders: (c: Context) => void,
): void {
  applyNoStoreHeaders(c);
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy',
    `frame-ancestors 'none'; script-src 'self' 'nonce-${scriptNonce}' ${CLERK_SCRIPT_ORIGIN} https://challenges.cloudflare.com https://www.googletagmanager.com; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'`);
}

/** Existing platform sign-in renderer, with no target lookup, token mint or upstream fetch. */
export function serveAnonymousExplicitVmRequest(input: {
  c: Context;
  route: ExplicitVmRoute;
  env: NodeJS.ProcessEnv;
  clerkConfigured: boolean;
  applyNoStoreHeaders(c: Context): void;
}): Response {
  const { c, route, env, applyNoStoreHeaders } = input;
  applyNoStoreHeaders(c);
  if (!isDocumentRequest(c, route)) return c.text('Unauthorized', 401);
  const target = explicitVmAuthReturnTarget(c.req.url);
  if (!target) return c.text('Invalid Matrix OS computer', 400);
  const publishableKey = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!publishableKey || !input.clerkConfigured) return c.text('Matrix OS sign-in unavailable', 503);
  const scriptNonce = randomBytes(16).toString('base64');
  applyAuthPageHeaders(c, scriptNonce, applyNoStoreHeaders);
  const runtimeSlot = route.runtimeSlot ?? readRuntimeSlotSelection(c.req.url).slot;
  return c.html(getAuthPage(publishableKey, 'sign-in', scriptNonce, target, appOrigin(env), {
    explicitVmReturn: { runtimeSlot },
  }));
}
