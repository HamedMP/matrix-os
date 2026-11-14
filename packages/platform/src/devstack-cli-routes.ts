import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { desktopFonts, desktopPalette as colors, radii } from '@matrix-os/brand/tokens';
import { browserAuthContentSecurityPolicy } from './auth-pages.js';
import { hasVerifiedClerkBrowserSession, type ClerkAuth } from './clerk-auth.js';
import { createDevstackCliPairing, type DevstackCliBinding } from './devstack-cli-pairing.js';
import { devstackApprovalOrigin } from './devstack-approval-origin.js';
import { DevstackInstanceSchema } from './devstack-identity.js';
import { isDevstackBrowserOperator, matchesRegisteredPreviewTarget, readDevstackBrowserSession,
  type DevstackBrowserMembership } from './devstack-preview-auth.js';
import { devstackWorktreePreviewRoot } from './devstack-preview-path.js';
import { renderDevstackPreviewSignIn } from './devstack-preview-sign-in.js';
import type { RegisteredRuntimeEndpoint } from './devstack-registered-runtime.js';
import type { DevstackPreviewConfig, DevstackPreviewTarget } from './devstack-runs/config.js';
import { DEVSTACK_SOURCE_DELTA_MAX_BYTES, parseDevstackSourceDelta, type DevstackSourceDelta } from './devstack-source-delta.js';
import { escapeHtml, escapeHtmlAttr } from './html-escaping.js';
import { createBoundedRateLimiter, runtimeSelectionSourceKey } from './request-admission.js';
import { EDGE_SECRET_HEADER } from './session-routing-proxy.js';
import { getTrustedSessionRouteHost } from './session-routing-websocket.js';
import { normalizeSessionHost } from './ws-upgrade.js';

const pairPath = '/devstack/cli/pair';
const pollPath = '/devstack/cli/poll';
const sourcePath = '/devstack/cli/source';
const sourceSchema = z.strictObject({ sourceIdentity: z.string().length(64).regex(/^[0-9a-f]+$/) });
const codeSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/);
const pollSchema = z.strictObject({ pollSecret: codeSchema });
const requestLimit = bodyLimit({
  maxSize: 1024,
  onError: c => c.json({ error: 'DevStack CLI request is too large' }, 413),
});

export interface DevstackSourceReceipt {
  revision: string;
  files: number;
  updated: number;
  removed: number;
  test: { revision: string; exitCode: number; log: string };
}

class StaleSourceBinding extends Error {}

interface CliRoutesDeps {
  config: DevstackPreviewConfig;
  clerkAuth: ClerkAuth;
  approvalClerkAuth?: ClerkAuth;
  publishableKey: string;
  edgeRouterSecret?: string;
  approvalOrigin?: string;
  enabledWorktrees: ReadonlySet<string>;
  source?: {
    identity: string;
    apply(binding: DevstackCliBinding, delta: DevstackSourceDelta,
      assertCurrent: () => Promise<void>): Promise<DevstackSourceReceipt>;
  };
  isMember: DevstackBrowserMembership;
  resolve(target: DevstackPreviewTarget): Promise<Pick<RegisteredRuntimeEndpoint, 'handle' | 'clerkUserId' | 'containerId'> | null>;
}

export function isDevstackCliPath(method: string, path: string, sourceEnabled = false): boolean {
  if (path === sourcePath) return sourceEnabled && method === 'POST';
  if (path === pairPath || path === pollPath) return method === 'POST';
  if (method !== 'GET' && method !== 'POST') return false;
  return path.startsWith(pairPath + '/') && codeSchema.safeParse(path.slice(pairPath.length + 1)).success;
}

async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') return;
  try {
    const parsed = schema.safeParse(await c.req.json());
    if (parsed.success) return parsed.data;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

function renderApproval(path: string, fingerprint: string, targets: DevstackPreviewTarget[], nonce: string): string {
  const choices = targets.map(({ worktree }) =>
    `<li><button type="submit" name="worktree" value="${escapeHtmlAttr(worktree)}">Connect ${escapeHtml(worktree)}</button></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Connect DevStack · Matrix OS</title><style nonce="${nonce}">
* { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 1.5rem;
  background: ${colors.canvas}; color: ${colors.forest}; font: 1rem/1.6 ${desktopFonts.sans}; }
main { width: 100%; max-width: 30rem; padding: clamp(1.5rem, 6vw, 3rem);
  background: ${colors.paper}; border-radius: ${radii.card}; }
.brand { margin: 0 0 2rem; font-weight: 650; }
h1 { margin: 0 0 1rem; font: 650 1.75rem/1.2 ${desktopFonts.display}; }
p { margin: 0 0 1.5rem; color: ${colors.textMuted}; }
code { display: block; width: fit-content; margin-top: .75rem; padding: .5rem .75rem;
  background: ${colors.surfaceMuted}; color: ${colors.forest}; border-radius: ${radii.control};
  font: 1rem/1.5 ${desktopFonts.mono}; letter-spacing: .08em; }
ul { display: grid; gap: .75rem; margin: 0; padding: 0; list-style: none; }
button { width: 100%; min-height: 2.75rem; padding: .75rem 1rem; border: 0;
  border-radius: ${radii.control}; background: ${colors.forest}; color: ${colors.paper};
  font: 600 1rem/1.5 ${desktopFonts.sans}; cursor: pointer; overflow-wrap: anywhere; }
button:hover { background: ${colors.forestHover}; }
button:focus-visible { outline: 3px solid ${colors.forest}; outline-offset: 4px; }
</style></head>
<body><main><p class="brand">Matrix OS</p><h1>Connect your Matrix CLI</h1>
<p>Match this source fingerprint with the one in your terminal, then choose your worktree.
<code>${escapeHtml(fingerprint.slice(0, 12))}</code></p>
<form method="post" action="${escapeHtmlAttr(path)}"><ul>${choices}</ul></form>
</main></body></html>`;
}

export function createDevstackCliRoutes(deps: CliRoutesDeps) {
  const app = new Hono();
  const origin = deps.config.previewOrigin;
  const host = new URL(origin).hostname;
  const pairing = createDevstackCliPairing();
  const source = deps.source;
  const approvalOrigin = source || deps.approvalOrigin
    ? devstackApprovalOrigin(deps.approvalOrigin, origin) : origin;
  if (source && !z.string().length(64).regex(/^[0-9a-f]+$/).safeParse(source.identity).success) {
    throw new Error('Invalid DevStack source enrollment');
  }
  const startRate = createBoundedRateLimiter(20);
  const pollRate = createBoundedRateLimiter(120);
  const browserRate = createBoundedRateLimiter(60);
  const sourceRate = createBoundedRateLimiter(60);
  const unavailable = (c: Context) => c.json({ error: 'DevStack CLI connection unavailable' }, 404);

  app.onError((error, c) => {
    console.error('[platform] DevStack CLI pairing failed', error.name);
    return c.json({ error: 'DevStack CLI connection temporarily unavailable' }, 503);
  });
  app.use('/devstack/cli/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    const routed = getTrustedSessionRouteHost(c.req.header('host'), c.req.header('x-forwarded-host'),
      c.req.header(EDGE_SECRET_HEADER), deps.edgeRouterSecret);
    const approving = c.req.path.startsWith(pairPath + '/');
    const expectedOrigin = approving ? approvalOrigin : origin;
    if (!deps.config.publicBrowserOnly || normalizeSessionHost(routed) !== (approving ? new URL(approvalOrigin).hostname : host)
      || !isDevstackCliPath(c.req.method, c.req.path, Boolean(source)) || new URL(c.req.url).search) return unavailable(c);
    const requestOrigin = c.req.header('origin');
    if ((requestOrigin && requestOrigin !== expectedOrigin) ||
      (c.req.method === 'POST' && approving && requestOrigin !== approvalOrigin)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const limiter = c.req.path === pairPath ? startRate : c.req.path === pollPath ? pollRate
      : c.req.path === sourcePath ? sourceRate : browserRate;
    if (!limiter.check(runtimeSelectionSourceKey(c, deps.edgeRouterSecret))) {
      return c.json({ error: 'Try again later' }, 429);
    }
    await next();
  });

  app.post(pairPath, requestLimit, async c => {
    const input = await readJson(c, sourceSchema);
    if (!input) return c.json({ error: 'Invalid DevStack CLI request' }, 400);
    if (source && source.identity !== input.sourceIdentity) return unavailable(c);
    const request = pairing.create(input.sourceIdentity);
    return request ? c.json({ ...request, ...(approvalOrigin !== origin && { approvalOrigin }) }, 201)
      : c.json({ error: 'Try again later' }, 429);
  });

  app.post(pollPath, requestLimit, async c => {
    const input = await readJson(c, pollSchema);
    if (!input) return c.json({ error: 'Invalid DevStack CLI request' }, 400);
    const result = pairing.poll(input.pollSecret);
    if (result.status === 'pending') return c.json({ status: 'pending' }, 202);
    if (result.status === 'capacity') return c.json({ error: 'Try again later' }, 429);
    if (result.status !== 'approved') return unavailable(c);
    const { bearer, expiresAt, binding: { runtime, worktree, sourceIdentity } } = result;
    return c.json({ bearer, expiresAt, binding: { runtime, worktree, sourceIdentity, ...(source && { sourceSync: true }) } });
  });

  if (source) {
    app.post(sourcePath, async (c, next) => {
      // Authenticate before accepting a multi-megabyte payload.
      const authorization = c.req.header('authorization');
      const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!pairing.authenticate(bearer)) return c.json({ error: 'Authentication required' }, 401);
      await next();
    }, bodyLimit({
      maxSize: DEVSTACK_SOURCE_DELTA_MAX_BYTES,
      onError: c => c.json({ error: 'DevStack CLI request is too large' }, 413),
    }), async c => {
      const authorization = c.req.header('authorization');
      const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      const binding = pairing.authenticate(bearer);
      if (!binding) return c.json({ error: 'Authentication required' }, 401);
      const target = deps.config.targets.find(entry => entry.owner === binding.owner
        && entry.runtime === binding.runtime && entry.worktree === binding.worktree
        && entry.handle === binding.handle && entry.containerId === binding.containerId);
      if (!target || !deps.enabledWorktrees.has(target.worktree) ||
        binding.sourceIdentity !== source.identity) return unavailable(c);
      let delta;
      try {
        if (c.req.header('content-type')?.split(';')[0]?.trim() === 'application/json') {
          delta = parseDevstackSourceDelta(await c.req.json());
        }
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (!delta) return c.json({ error: 'Invalid DevStack source delta' }, 400);
      const approvedTarget = target;
      async function assertCurrent() {
        const token = pairing.browserTokenFor(bearer);
        if (!token || pairing.authenticate(bearer) !== binding ||
          !await deps.isMember(approvedTarget.owner, token) ||
          !matchesRegisteredPreviewTarget(await deps.resolve(approvedTarget), approvedTarget) ||
          pairing.authenticate(bearer) !== binding) throw new StaleSourceBinding();
      }
      try {
        await assertCurrent();
        const receipt = await source.apply(binding, delta, assertCurrent);
        await assertCurrent();
        return c.json(receipt);
      } catch (error: unknown) {
        if (error instanceof StaleSourceBinding) return c.json({ error: 'DevStack binding is no longer current' }, 409);
        throw error;
      }
    });
  }

  async function approve(c: Context): Promise<Response> {
    const approvalId = c.req.param('approvalId') ?? '';
    const pending = pairing.lookupApproval(approvalId);
    if (!pending) return unavailable(c);
    const auth = await readDevstackBrowserSession(deps.approvalClerkAuth ?? deps.clerkAuth, c.req.header('cookie'));
    if (!auth) {
      if (c.req.method !== 'GET') return c.json({ error: 'Authentication required' }, 401);
      const nonce = randomBytes(16).toString('base64');
      c.header('Content-Security-Policy', browserAuthContentSecurityPolicy(nonce));
      return c.html(renderDevstackPreviewSignIn(deps.publishableKey, nonce, c.req.path));
    }
    const owner = auth.session.userId;
    if (approvalOrigin !== origin && auth.session.authorizedParty !== approvalOrigin) {
      return c.json({ error: 'DevStack approval access required' }, 403);
    }
    if (!owner || !await isDevstackBrowserOperator(auth, deps.config, deps.isMember)) {
      return c.json({ error: 'DevStack access required' }, 403);
    }
    let worktree: string | undefined;
    if (c.req.method === 'POST') {
      if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') {
        return c.json({ error: 'Invalid DevStack CLI request' }, 400);
      }
      const form = new URLSearchParams(await c.req.text());
      const parsed = DevstackInstanceSchema.safeParse(form.get('worktree'));
      if (form.size !== 1 || !parsed.success) return c.json({ error: 'Invalid DevStack CLI request' }, 400);
      worktree = parsed.data;
    }
    const owned = deps.config.targets.filter(target => target.owner === owner
      && deps.enabledWorktrees.has(target.worktree) && (worktree === undefined || target.worktree === worktree));
    const resolved = await Promise.all(owned.map(async target =>
      matchesRegisteredPreviewTarget(await deps.resolve(target), target) ? target : null));
    const available = resolved.filter(target => target !== null);
    if (!available.length) return unavailable(c);
    if (!hasVerifiedClerkBrowserSession(auth.session, owner)) return c.json({ error: 'Authentication required' }, 401);
    if (worktree === undefined) {
      const nonce = randomBytes(16).toString('base64');
      c.header('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      return c.html(renderApproval(c.req.path, pending.sourceIdentity, available, nonce));
    }
    const target = available[0];
    if (available.length !== 1 || !target || !pairing.approve(approvalId, { ...target, clerkSessionId: auth.session.sessionId }, {
      token: auth.token, expiresAt: auth.session.tokenExpiresAt * 1000,
    })) {
      return c.json({ error: 'DevStack CLI approval no longer available' }, 409);
    }
    return c.redirect((approvalOrigin === origin ? '' : origin) + devstackWorktreePreviewRoot(worktree), 303);
  }
  app.get(pairPath + '/:approvalId', approve);
  app.post(pairPath + '/:approvalId', requestLimit, approve);
  return app;
}
