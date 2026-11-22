import type { Context } from 'hono';
import { readCookie } from './session-cookies.js';

/**
 * App-domain helpers shared by session routing (spec 2691, ENG-520): the route
 * class logged for upstream 5xx answers, and the marker that sends server
 * actions from platform auth-shell pages back to the auth shell.
 */

const EXACT_LOGGED_PATHS = new Set(['/', '/sign-in', '/sign-up', '/runtime', '/onboarding/computer', '/vm']);
const PREFIX_LOGGED_PATHS = ['/_next', '/__platform-shell', '/files', '/shared', '/apps', '/vm', '/ws'];
const API_GROUP = /^[a-z0-9-]{1,32}$/;

/**
 * A loggable class for an app-domain path: a few exact routes, a fixed prefix
 * plus `/*`, or `/api/<group>[/*]`; anything else is `other`. Paths carry user
 * content (file names, app slugs, invitation ids), so the raw path is never logged.
 */
export function appDomainPathClass(path: string): string {
  if (EXACT_LOGGED_PATHS.has(path)) return path;
  for (const prefix of PREFIX_LOGGED_PATHS) {
    if (path.startsWith(`${prefix}/`)) return `${prefix}/*`;
  }
  const api = /^\/api\/([^/]+)(\/.*)?$/.exec(path);
  if (api && API_GROUP.test(api[1]!)) return api[2] ? `/api/${api[1]}/*` : `/api/${api[1]}`;
  return 'other';
}

/**
 * A 5xx an upstream answered on the app domain is passed through to the
 * browser; log which upstream, the method, the path class (never the path or
 * query, which carry user content and tokens) and whether it was a Next server
 * action, so a bare 500 can be traced. The runtime handle is the only identity.
 */
export function logAppDomainUpstreamFailure(
  upstream: 'auth-shell' | 'runtime',
  c: Context,
  status: number,
  handle?: string,
): void {
  const serverAction = c.req.header('next-action') !== undefined;
  console.error(`[platform] app-domain ${upstream} upstream status=${status} method=${c.req.method}`
    + ` path_class=${appDomainPathClass(c.req.path)} server_action=${serverAction}${handle ? ` handle=${handle}` : ''}`);
}

/**
 * Marks documents the platform's auth shell served (spec 2691 post-sign-in
 * fix): a Next server action posted from such a page (Clerk's cache
 * invalidation after sign-in) must reach the auth shell that knows the action,
 * not the owner's runtime that may have become routable meanwhile. Short-lived,
 * HttpOnly, Lax; cleared when the runtime serves a document.
 */
export const PLATFORM_SHELL_DOCUMENT_COOKIE = 'matrix_platform_shell';
export const PLATFORM_SHELL_DOCUMENT_COOKIE_SET =
  `${PLATFORM_SHELL_DOCUMENT_COOKIE}=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
export const PLATFORM_SHELL_DOCUMENT_COOKIE_CLEAR =
  `${PLATFORM_SHELL_DOCUMENT_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function isHtmlDocumentResponse(method: string, headers: Headers): boolean {
  return method === 'GET' && (headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');
}

export function isPlatformShellServerAction(c: Context, cookieHeader: string | undefined): boolean {
  return c.req.method === 'POST' && c.req.header('next-action') !== undefined
    && readCookie(cookieHeader, PLATFORM_SHELL_DOCUMENT_COOKIE) === '1';
}
