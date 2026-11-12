import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { fonts, lightFg, palette } from '@matrix-os/brand/tokens';
import { browserAuthContentSecurityPolicy } from './auth-pages.js';
import { hasVerifiedClerkBrowserSession, type ClerkAuth } from './clerk-auth.js';
import { isDevstackBrowserOperator, matchesRegisteredPreviewTarget, readDevstackBrowserSession, type DevstackBrowserMembership } from './devstack-preview-auth.js';
import { DevstackInstanceSchema } from './devstack-identity.js';
import { devstackWorktreePreviewRoot, readDevstackWorktreePreviewPath } from './devstack-preview-path.js';
import { renderDevstackPreviewSignIn } from './devstack-preview-sign-in.js';
import type { RegisteredRuntimeEndpoint } from './devstack-registered-runtime.js';
import type { DevstackPreviewConfig, DevstackPreviewTarget } from './devstack-runs/config.js';
import { escapeHtml, escapeHtmlAttr } from './html-escaping.js';
import { EDGE_SECRET_HEADER } from './session-routing-proxy.js';
import { getTrustedSessionRouteHost } from './session-routing-websocket.js';
import { normalizeSessionHost } from './ws-upgrade.js';

interface DevstackPreviewDeps {
  config: DevstackPreviewConfig;
  clerkAuth: ClerkAuth;
  publishableKey: string;
  edgeRouterSecret?: string;
  isMember: DevstackBrowserMembership;
  resolve(target: DevstackPreviewTarget): Promise<Pick<RegisteredRuntimeEndpoint, 'handle' | 'clerkUserId' | 'containerId'> | null>;
}

function renderWorktrees(targets: DevstackPreviewTarget[], publicBrowserOnly: boolean): string {
  const links = targets.map(target => {
    const path = publicBrowserOnly ? devstackWorktreePreviewRoot(target.worktree) : `/devstack/${target.runtime}/${target.worktree}`;
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
  const previewOrigin = new URL(deps.config.previewOrigin);
  const previewHost = deps.config.publicBrowserOnly ? previewOrigin.hostname : previewOrigin.host;
  const unavailable = (c: Context) => c.text('DevStack worktree unavailable', 404);

  async function open(c: Context): Promise<Response> {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    const host = getTrustedSessionRouteHost(
      c.req.header('host'), c.req.header('x-forwarded-host'), c.req.header(EDGE_SECRET_HEADER), deps.edgeRouterSecret,
    );
    const routedHost = deps.config.publicBrowserOnly ? normalizeSessionHost(host) : host.toLowerCase();
    if (routedHost !== previewHost) return unavailable(c);
    const url = new URL(c.req.url);
    if (url.search) return c.text('Invalid DevStack worktree selection', 400);

    const runtime = c.req.param('runtime');
    const worktree = c.req.param('worktree');
    const stablePath = readDevstackWorktreePreviewPath(url.pathname);
    if (runtime !== undefined && (!DevstackInstanceSchema.safeParse(runtime).success || runtime.includes('\n')
      || !DevstackInstanceSchema.safeParse(worktree).success || worktree?.includes('\n'))) return unavailable(c);
    const showChooser = deps.config.publicBrowserOnly && c.req.path === '/devstack/computers';
    const returnPath = showChooser ? '/devstack/computers'
      : stablePath ? devstackWorktreePreviewRoot(stablePath.worktree)
      : runtime && worktree ? `/devstack/${runtime}/${worktree}` : '/devstack';
    // Require a canonical, unencoded path before including it in the sign-in page.
    if (url.pathname !== returnPath) return unavailable(c);

    const auth = await readDevstackBrowserSession(deps.clerkAuth, c.req.header('cookie'));
    if (!auth) {
      const nonce = randomBytes(16).toString('base64');
      c.header('Content-Security-Policy', browserAuthContentSecurityPolicy(nonce));
      return c.html(renderDevstackPreviewSignIn(deps.publishableKey, nonce, returnPath));
    }
    const { session } = auth;
    const actor = session.userId;
    if (!actor || !await isDevstackBrowserOperator(auth, deps.config, deps.isMember)) {
      return c.text('DevStack access required', 403);
    }

    const owned = deps.config.targets.filter(target => target.owner === actor
      && (runtime === undefined || (target.runtime === runtime && target.worktree === worktree))
      && (!stablePath || target.worktree === stablePath.worktree));
    if (stablePath && owned.length !== 1) return unavailable(c);
    const registered = await Promise.all(owned.map(async target => {
      const endpoint = await deps.resolve(target);
      return matchesRegisteredPreviewTarget(endpoint, target) ? target : null;
    }));
    if (!hasVerifiedClerkBrowserSession(session, actor)) return c.text('DevStack session expired. Reload to sign in.', 401);
    const available = registered.filter(target => target !== null);
    if (available.length === 0) return unavailable(c);
    const [only] = available;
    if (!showChooser && available.length === 1 && only) {
      const destination = deps.config.publicBrowserOnly && runtime === undefined
        ? devstackWorktreePreviewRoot(only.worktree) : `/vm/${only.handle}/`;
      return c.redirect(destination, 302);
    }
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    return c.html(renderWorktrees(available, deps.config.publicBrowserOnly ?? false));
  }

  app.onError((error, c) => {
    console.error('[platform] DevStack worktree selection failed', error.name);
    return c.text('DevStack temporarily unavailable', 503);
  });
  app.get('/devstack', open);
  if (deps.config.publicBrowserOnly) app.get('/devstack/computers', open);
  else app.get('/devstack/worktrees/:worktree/', open);
  app.get('/devstack/:runtime/:worktree', open);
  return app;
}
