import type { Context } from 'hono';

/**
 * Logging for 5xx answers an app-domain upstream (the platform auth shell or
 * the owner's runtime) returns through session routing. Found during ENG-520:
 * bare 500s on "/" right after sign-in left no platform log line.
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
