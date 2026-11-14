import { randomBytes } from 'node:crypto';
import { MatrixComputerListSchema } from '@matrix-os/contracts';
import type { MiddlewareHandler } from 'hono';
import { browserAuthContentSecurityPolicy } from './auth-pages.js';
import { isDevstackCliPath } from './devstack-cli-routes.js';
import { devstackApprovalOrigin } from './devstack-approval-origin.js';
import { hasVerifiedClerkBrowserSession, type ClerkAuth } from './clerk-auth.js';
import { isDevstackBrowserOperator, matchesRegisteredPreviewTarget, readDevstackBrowserSession, type DevstackBrowserMembership } from './devstack-preview-auth.js';
import { readDevstackWorktreePreviewPath } from './devstack-preview-path.js';
import { isDevstackPreviewRoot, renderDevstackPreviewSignIn } from './devstack-preview-sign-in.js';
import type { RegisteredRuntimeEndpoint } from './devstack-registered-runtime.js';
import type { DevstackPreviewConfig, DevstackPreviewTarget } from './devstack-runs/config.js';
import { readExplicitRuntimePath, readExplicitVmRoute, type AppDomainIdentity, type ExplicitVmRoute } from './session-routing-identity.js';
import { EDGE_SECRET_HEADER } from './session-routing-proxy.js';
import { getTrustedSessionRouteHost } from './session-routing-websocket.js';
import { normalizeSessionHost } from './ws-upgrade.js';

type PreviewTargetSelector = { handle: string } | { worktree: string };
type BrowserPreviewRoute = Omit<ExplicitVmRoute, 'handle'> & { selector: PreviewTargetSelector };
type VerifiedPreview = { identity: AppDomainIdentity; endpoint: RegisteredRuntimeEndpoint };
export type DevstackPublicPreviewBinding = VerifiedPreview & { route: ExplicitVmRoute; worktree?: string };
type PublicPreviewDenial = { status: 401 | 403 | 404 | 503; noSession?: true };

interface PublicPreviewDeps {
  config: DevstackPreviewConfig;
  clerkAuth: ClerkAuth;
  publishableKey: string;
  edgeRouterSecret?: string;
  cliPairingEnabled?: boolean;
  cliSourceEnabled?: boolean;
  approvalOrigin?: string;
  isMember: DevstackBrowserMembership;
  resolve(target: DevstackPreviewTarget): Promise<RegisteredRuntimeEndpoint | null>;
}

export type DevstackPublicPreviewAccess = ReturnType<typeof createDevstackPublicPreviewAccess>;

function readBrowserPreviewRoute(path: string): BrowserPreviewRoute | null {
  if (path.includes('//')) return null;
  const worktree = readDevstackWorktreePreviewPath(path);
  const vmRoute = worktree ? null : readExplicitVmRoute(path);
  const route = worktree ? readExplicitRuntimePath(worktree.suffix) : vmRoute;
  const selector = worktree ? { worktree: worktree.worktree } : vmRoute && { handle: vmRoute.handle };
  if (!selector || !route || (route.runtimeSlot && route.runtimeSlot !== 'primary')) return null;
  // Decode once before applying the browser route boundary. Reject ambiguous
  // path separators, double-encoding and dot segments before downstream parsing.
  let segments: string[];
  try {
    segments = route.upstreamPath.split('/').map(segment => decodeURIComponent(segment));
  } catch (error: unknown) {
    if (error instanceof URIError) return null;
    throw error;
  }
  if (segments.some(segment => segment === '.' || segment === '..'
      || /[/\\?#\x00-\x1f\x7f]|%[0-9a-f]{2}/i.test(segment))) return null;
  if (/^\/(?:internal|proxy|api\/(?:internal|operator|devstack))(?:\/|$)/i.test(segments.join('/'))) return null;
  return { ...route, selector };
}

function isBrowserPreviewRoot(path: string): boolean {
  return isDevstackPreviewRoot(path) || readDevstackWorktreePreviewPath(path)?.suffix === '';
}

function bindPreviewRoute(binding: VerifiedPreview, route: BrowserPreviewRoute): DevstackPublicPreviewBinding {
  const worktree = 'worktree' in route.selector ? route.selector.worktree : undefined;
  return {
    ...binding,
    worktree,
    route: {
      handle: binding.endpoint.handle,
      runtimeSlot: worktree ? 'primary' : route.runtimeSlot,
      upstreamPath: route.upstreamPath,
    },
  };
}

// The Shell asks for inventory on the origin root. Its referrer selects the
// preview but grants no access; authorize still checks the owner and registry.
function readInventoryTarget(referer: string | undefined, origin: string): PreviewTargetSelector | null | undefined {
  if (referer === undefined) return undefined;
  if (referer.length > 4096) return null;
  try {
    const url = new URL(referer);
    if (url.origin !== origin || url.username || url.password) return null;
    if (url.pathname === '/' && !url.search) return undefined;
    return readBrowserPreviewRoute(url.pathname)?.selector ?? null;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function createDevstackPublicPreviewAccess(deps: PublicPreviewDeps) {
  const origin = deps.config.previewOrigin;
  const publicHostname = new URL(origin).hostname;
  const approvalHostname = deps.approvalOrigin
    ? new URL(devstackApprovalOrigin(deps.approvalOrigin, origin)).hostname : undefined;
  // Only the configured operators reach this lookup. Coalesce parallel browser
  // requests without keeping a membership decision after the lookup settles.
  const membershipRequests = new Map<string, Promise<boolean>>();
  function isMember(actorId: string, token: string): Promise<boolean> {
    if (deps.config.membershipSource === 'private-preview-api') return deps.isMember(actorId, token);
    const pending = membershipRequests.get(actorId);
    if (pending) return pending;
    const request = deps.isMember(actorId, token).finally(() => membershipRequests.delete(actorId));
    membershipRequests.set(actorId, request);
    return request;
  }
  function matchesHost(host: string | undefined): boolean {
    return host !== undefined && normalizeSessionHost(host) === publicHostname;
  }

  async function authorize(selector: PreviewTargetSelector | undefined, cookie?: string): Promise<{ binding: VerifiedPreview } | PublicPreviewDenial> {
    try {
      const auth = await readDevstackBrowserSession(deps.clerkAuth, cookie);
      if (!auth) return { status: 401, noSession: true };
      const { session } = auth;
      const actor = session.userId;
      if (!actor || !hasVerifiedClerkBrowserSession(session, actor)) return { status: 401 };
      if (!await isDevstackBrowserOperator(auth, deps.config, isMember)) return { status: 403 };
      const targets = deps.config.targets.filter(entry => entry.owner === actor && (selector === undefined
        || ('worktree' in selector ? entry.worktree === selector.worktree : entry.handle === selector.handle)));
      const [target] = targets;
      if (!target || targets.length !== 1) return { status: 404 };
      const endpoint = await deps.resolve(target);
      if (!endpoint || !matchesRegisteredPreviewTarget(endpoint, target)) return { status: 404 };
      if (!hasVerifiedClerkBrowserSession(session, actor)) return { status: 401 };
      return {
        binding: {
          endpoint,
          identity: {
            handle: endpoint.handle, userId: actor, source: 'auth', runtimeSlot: 'primary',
            sessionProvenance: 'clerk-browser', verifiedHumanBrowserExpiresAt: session.tokenExpiresAt,
          },
        },
      };
    } catch (error: unknown) {
      console.error('[platform] public DevStack access verification failed', error instanceof Error ? error.name : 'Unknown error');
      return { status: 503 };
    }
  }

  async function authorizeUpgrade(path: string, requestOrigin: string | undefined, cookie?: string): Promise<{ binding: DevstackPublicPreviewBinding } | PublicPreviewDenial> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#\x00-\x1f\x7f]/.test(path)) return { status: 404 };
    const route = readBrowserPreviewRoute(path.split('?')[0] ?? '');
    if (!route || !/^\/(?:_next\/(?:webpack-)?hmr|ws(?:\/.*)?)$/.test(route.upstreamPath)) return { status: 404 };
    if (requestOrigin !== origin) return { status: 403 };
    const access = await authorize(route.selector, cookie);
    return 'status' in access ? access : { binding: bindPreviewRoute(access.binding, route) };
  }

  const middleware: MiddlewareHandler<{ Variables: { devstackPublicPreviewBinding?: DevstackPublicPreviewBinding } }> = async (c, next) => {
    const rawHost = c.req.header('host');
    const trustedHost = getTrustedSessionRouteHost(
      rawHost, c.req.header('x-forwarded-host'), c.req.header(EDGE_SECRET_HEADER), deps.edgeRouterSecret,
    );
    if (approvalHostname && (normalizeSessionHost(trustedHost) === approvalHostname || normalizeSessionHost(rawHost ?? '') === approvalHostname)) {
      c.header('Cache-Control', 'private, no-store');
      // Run before every Platform route. This host must never proxy a runtime,
      // an editable asset, a service worker, or an unrelated Platform handler.
      if (normalizeSessionHost(trustedHost) !== approvalHostname || !deps.cliPairingEnabled
        || !c.req.path.startsWith('/devstack/cli/pair/') || !isDevstackCliPath(c.req.method, c.req.path)) {
        return c.text('Not Found', 404);
      }
      return next();
    }
    if (!matchesHost(trustedHost) && !matchesHost(rawHost)) return next();
    c.header('Cache-Control', 'private, no-store');
    if (!matchesHost(trustedHost)) return c.text('Not Found', 404);
    const url = new URL(c.req.url);
    const path = url.pathname;
    if (deps.cliPairingEnabled && isDevstackCliPath(c.req.method, path, deps.cliSourceEnabled)) return next();
    const cookie = c.req.header('cookie');
    const navigationMethod = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (navigationMethod && path === '/') return c.redirect('/devstack', 302);
    if (navigationMethod && path === '/runtime') return c.redirect('/devstack/computers', 302);
    if (navigationMethod && (path === '/devstack/computers' || /^\/devstack(?:\/[a-z0-9-]+\/[a-z0-9-]+)?$/.test(path))) return next();
    if (navigationMethod && path === '/api/auth/computers') {
      const target = readInventoryTarget(c.req.header('referer'), origin);
      if (target === null) return c.text('DevStack access unavailable', 404);
      const access = await authorize(target, cookie);
      if ('status' in access) return c.text('DevStack access unavailable', access.status);
      const registeredHandle = access.binding.endpoint.handle;
      return c.json(MatrixComputerListSchema.parse({
        items: [{ handle: registeredHandle, runtimeSlot: 'primary', label: 'Preview Computer', availability: 'available',
          kind: 'preview', gatewayPath: `/vm/${registeredHandle}`, capabilities: ['matrixComputerInventoryV1'] }],
        hasMore: false, limit: 1, selectedSlot: 'primary',
      }));
    }
    if (navigationMethod && path === '/sign-in') {
      const entries = [...url.searchParams];
      const redirect = entries[0]?.[1];
      if (entries.length !== 1 || entries[0]?.[0] !== 'redirect_url' || !redirect || !isBrowserPreviewRoot(redirect)) {
        return c.text('Invalid DevStack preview return path', 400);
      }
      const route = readBrowserPreviewRoute(redirect);
      if (!route) return c.text('Not Found', 404);
      const access = await authorize(route.selector, cookie);
      if ('binding' in access) return c.redirect(redirect, 302);
      if (!access.noSession) return c.text('DevStack access unavailable', access.status);
      const nonce = randomBytes(16).toString('base64');
      c.header('X-Frame-Options', 'DENY');
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Content-Security-Policy', browserAuthContentSecurityPolicy(nonce));
      return c.html(renderDevstackPreviewSignIn(deps.publishableKey, nonce, redirect));
    }

    const route = readBrowserPreviewRoute(path);
    if (!route) return c.text('Not Found', 404);
    if (!navigationMethod && c.req.header('origin') !== origin) return c.text('Forbidden', 403);
    const access = await authorize(route.selector, cookie);
    if ('status' in access) {
      if (access.noSession && navigationMethod && isBrowserPreviewRoot(path)) {
        return c.redirect(`/sign-in?redirect_url=${encodeURIComponent(path)}`, 302);
      }
      return c.text('DevStack access unavailable', access.status);
    }
    c.set('devstackPublicPreviewBinding', bindPreviewRoute(access.binding, route));
    await next();
    c.header('Cache-Control', 'private, no-store');
    // An upstream CDN directive must not override the authorization boundary.
    c.header('CDN-Cache-Control', 'no-store');
    c.header('Cloudflare-CDN-Cache-Control', 'no-store');
  };

  return { matchesHost, authorizeUpgrade, middleware };
}
