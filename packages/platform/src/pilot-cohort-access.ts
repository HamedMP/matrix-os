import { isPilotCohortMember, type PilotCohortPolicy } from '@matrix-os/contracts';
import type { MiddlewareHandler } from 'hono';
import type { ClerkAuth, VerifyResult } from './clerk-auth.js';
import { isGmailOAuthCallback, isGmailPipedreamCallback } from './integration-public-path.js';
import { APP_SESSION_COOKIE, CODE_SESSION_COOKIE, readCookie } from './session-cookies.js';
import { verifySyncJwt } from './sync-jwt.js';

export class PilotCohortDenied extends Error {
  constructor() { super('Access unavailable'); this.name = 'PilotCohortDenied'; }
}

export function assertPilotCohortActor(policy: PilotCohortPolicy, actor: string | undefined): void {
  if (!isPilotCohortMember(policy, actor)) throw new PilotCohortDenied();
}

/** Recheck at the consuming verifier too; an earlier transient refusal is not approval. */
export function restrictClerkAuthToPilot(auth: ClerkAuth | undefined, policy: PilotCohortPolicy): ClerkAuth | undefined {
  if (!auth || policy.status === 'disabled') return auth;
  const restrict = (result: VerifyResult): VerifyResult => result.authenticated
    && !isPilotCohortMember(policy, result.userId)
    ? { authenticated: false, error: 'Access unavailable' } : result;
  return {
    extractToken: (header, cookie) => auth.extractToken(header, cookie),
    verify: async token => restrict(await auth.verify(token)),
    verifyAndMatchOwner: async (token, owner) => restrict(await auth.verifyAndMatchOwner(token, owner)),
    revokeSession: session => auth.revokeSession(session),
    isPublicPath: path => auth.isPublicPath(path),
  };
}

/** Routing eligibility only; the gateway must authenticate the opaque capability. */
export function isPilotAppCapabilityRequest(method: string, path: string, rawUrl: string, cookie: string | undefined): boolean {
  const slug = /^\/apps\/([a-z0-9][a-z0-9-]{0,63})(?:\/|$)/.exec(path)?.[1];
  if (!slug) return false;
  const sessions = new URL(rawUrl).searchParams.getAll('session');
  if (sessions.length) return (method === 'GET' || method === 'HEAD') && sessions.length === 1 && sessions[0].length <= 256
    && /^[a-z0-9][a-z0-9-]*\.[A-Za-z0-9_-]{43}$/.test(sessions[0]);
  const appCookie = readCookie(cookie, `matrix_app_session__${slug}`);
  return Boolean(appCookie && appCookie.length <= 4096 && /^[A-Za-z0-9_.-]+$/.test(appCookie));
}

/** Exact capability protocols retain their own one-use state / secret checks. */
function independentCapability(method: string, path: string): boolean {
  return (method === 'GET' && path === '/health')
    || isGmailOAuthCallback(method, path) || isGmailPipedreamCallback(method, path)
    || (method === 'POST' && path === '/api/integrations/webhook/connected')
    || (method === 'POST' && (path === '/api/auth/device/code' || path === '/api/auth/device/token'));
}

/**
 * Extra admission, never authentication: invalid/absent credentials still reach
 * the existing route-specific verifier. Checks all supported session carriers
 * so a second signed nonmember cookie cannot become a downstream fallback.
 * Internal machine/operator tokens are not user JWTs and retain their guards.
 */
export function createPilotCohortAccessGuard(opts: {
  policy: PilotCohortPolicy;
  clerkAuth?: ClerkAuth;
  jwtSecret: string;
}): MiddlewareHandler {
  return async (c, next) => {
    if (opts.policy.status === 'disabled' || independentCapability(c.req.method, c.req.path)) return next();
    const deny = (status: 401 | 403 | 503) => {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'Access unavailable' }, status);
    };
    if (opts.policy.status === 'invalid') return deny(503);
    const cookie = c.req.header('cookie');
    const tokens = [
      c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1],
      readCookie(cookie, '__session'), readCookie(cookie, APP_SESSION_COOKIE), readCookie(cookie, CODE_SESSION_COOKIE),
    ];
    for (const token of tokens) {
      if (!token) continue;
      // Match the existing dedicated MCP OAuth verifier's bounded contract;
      // the admission guard must not truncate another authenticated protocol.
      if (token.length > 16_384) return deny(401);
      if (opts.clerkAuth) {
        const result = await opts.clerkAuth.verify(token);
        if (result.authenticated && !isPilotCohortMember(opts.policy, result.userId)) return deny(403);
      }
      if (!opts.jwtSecret) continue;
      try {
        const claims = await verifySyncJwt(token, { secret: opts.jwtSecret });
        if (!isPilotCohortMember(opts.policy, claims.sub)) return deny(403);
      } catch (error: unknown) {
        // Signature/claim refusal is ordinary; configuration failures must not
        // look like an absent user and permit downstream fallback.
        if (!(error instanceof Error) || !(error.name.startsWith('JWT') || error.name.startsWith('JWS')
          || error.name.startsWith('JOSE') || error.message === 'Invalid sync JWT claims')) throw error;
      }
    }
    await next();
    if (c.res.status >= 400) c.header('Cache-Control', 'no-store');
  };
}
