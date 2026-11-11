import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { fonts, lightFg, palette } from '@matrix-os/brand/tokens';
import { browserAuthContentSecurityPolicy } from './auth-pages.js';
import { hasVerifiedClerkBrowserSession, type ClerkAuth } from './clerk-auth.js';
import { DevstackInstanceSchema } from './devstack-identity.js';
import { renderDevstackPreviewSignIn } from './devstack-preview-sign-in.js';
import type { RegisteredRuntimeEndpoint } from './devstack-registered-runtime.js';
import type { DevstackPreviewConfig, DevstackPreviewTarget } from './devstack-runs/config.js';
import { escapeHtml, escapeHtmlAttr } from './html-escaping.js';
import { EDGE_SECRET_HEADER } from './session-routing-proxy.js';
import { getTrustedSessionRouteHost } from './session-routing-websocket.js';

interface DevstackPreviewDeps {
  config: DevstackPreviewConfig;
  clerkAuth: ClerkAuth;
  publishableKey: string;
  edgeRouterSecret?: string;
  isMember(actorId: string): Promise<boolean>;
  resolve(target: DevstackPreviewTarget): Promise<Pick<RegisteredRuntimeEndpoint, 'handle' | 'clerkUserId' | 'containerId'> | null>;
}

function renderWorktrees(targets: DevstackPreviewTarget[]): string {
  const links = targets.map(target => {
    const path = `/devstack/${target.runtime}/${target.worktree}`;
    return `<li><a href="${escapeHtmlAttr(path)}">${escapeHtml(target.worktree)}</a> <small>${escapeHtml(target.runtime)}</small></li>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>DevStack worktrees</title>
  <style>
    body { margin: 0; background: ${palette.deep}; color: ${lightFg}; font-family: ${fonts.sans}; }
    main { max-width: 40rem; margin: 4rem auto; padding: 0 1.25rem; }
    ul { padding-left: 1.25rem; }
    li { margin: 1rem 0; }
    a { color: inherit; font-weight: 600; }
    small { margin-left: 0.5rem; }
  </style>
</head>
<body><main><h1>Choose a DevStack worktree</h1><ul>${links}</ul></main></body>
</html>`;
}

export function createDevstackPreviewRoutes(deps: DevstackPreviewDeps) {
  const app = new Hono();
  const previewHost = new URL(deps.config.previewOrigin).host;
  const unavailable = (c: Context) => c.text('DevStack worktree unavailable', 404);

  async function open(c: Context): Promise<Response> {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    const host = getTrustedSessionRouteHost(
      c.req.header('host'), c.req.header('x-forwarded-host'), c.req.header(EDGE_SECRET_HEADER), deps.edgeRouterSecret,
    );
    if (host.toLowerCase() !== previewHost) return unavailable(c);
    if (new URL(c.req.url).search) return c.text('Invalid DevStack worktree selection', 400);

    const runtime = c.req.param('runtime');
    const worktree = c.req.param('worktree');
    if (runtime !== undefined && (!DevstackInstanceSchema.safeParse(runtime).success || runtime.includes('\n')
      || !DevstackInstanceSchema.safeParse(worktree).success || worktree?.includes('\n'))) return unavailable(c);
    const returnPath = runtime && worktree ? `/devstack/${runtime}/${worktree}` : '/devstack';
    // Require a canonical, unencoded path before including it in the sign-in page.
    if (c.req.path !== returnPath) return unavailable(c);

    const token = deps.clerkAuth.extractToken(undefined, c.req.header('cookie'));
    const session = token && token.length <= 8192 ? await deps.clerkAuth.verify(token) : null;
    if (!session?.authenticated) {
      const nonce = randomBytes(16).toString('base64');
      c.header('Content-Security-Policy', browserAuthContentSecurityPolicy(nonce));
      return c.html(renderDevstackPreviewSignIn(deps.publishableKey, nonce, returnPath));
    }
    const actor = session.userId;
    if (!actor || session.issuer !== deps.config.issuer || session.restrictedSession
      || !deps.config.operators.includes(actor) || !hasVerifiedClerkBrowserSession(session, actor)
      || !/^sess_[A-Za-z0-9_]{1,128}$/.test(session.sessionId) || !await deps.isMember(actor) || !hasVerifiedClerkBrowserSession(session, actor)) {
      return c.text('DevStack access required', 403);
    }

    const owned = deps.config.targets.filter(target => target.owner === actor
      && (runtime === undefined || (target.runtime === runtime && target.worktree === worktree)));
    const registered = await Promise.all(owned.map(async target => {
      const endpoint = await deps.resolve(target);
      return endpoint?.containerId === target.containerId && endpoint.handle === target.handle && endpoint.clerkUserId === actor
        ? target : null;
    }));
    if (!hasVerifiedClerkBrowserSession(session, actor)) return c.text('DevStack session expired. Reload to sign in.', 401);
    const available = registered.filter(target => target !== null);
    if (available.length === 0) return unavailable(c);
    const [only] = available;
    if (available.length === 1 && only) return c.redirect(`/vm/${only.handle}/`, 302);
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    return c.html(renderWorktrees(available));
  }

  app.onError((error, c) => {
    console.error('[platform] DevStack worktree selection failed', error.name);
    return c.text('DevStack temporarily unavailable', 503);
  });
  app.get('/devstack', open);
  app.get('/devstack/:runtime/:worktree', open);
  return app;
}
