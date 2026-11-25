// Browser WebSocket upgrades carry no CORS protection: a page on any site can
// open one, and the browser sends whatever ambient credentials the target
// ingress adds. On a private self-hosted computer the nginx in front of the
// gateway authenticates the owner by Tailscale identity and injects the
// runtime bearer on every /ws request, so the requesting page never needs a
// token. Every WebSocket upgrade therefore checks the browser's Origin first.
import type { Hono, MiddlewareHandler } from "hono";

export interface WebSocketOriginPolicy {
  /** False where credentials are never ambient: the gate then changes nothing. */
  enforce: boolean;
  isAllowed(origin: string): boolean;
}

const PRIVATE_ACCESS_MODES = new Set(["tailscale", "headscale"]);

/** `http://` and `https://` for the tailnet URL's host: the installer falls back to HTTP when certificates are off. */
function tailnetOrigins(value: string | undefined): string[] {
  if (!value) return [];
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    console.warn("[gateway] Ignoring an invalid MATRIX_TAILNET_URL for WebSocket origins");
    return [];
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port
    || url.pathname !== "/" || url.search || url.hash) {
    console.warn("[gateway] Ignoring an invalid MATRIX_TAILNET_URL for WebSocket origins");
    return [];
  }
  return [`https://${url.hostname}`, `http://${url.hostname}`];
}

/**
 * Enforced on a self-hosted computer in a private access mode, where the
 * ingress adds the owner's credentials. The allowed origins are the gateway's
 * configured browser origins (SHELL_ORIGIN, which the installer sets to the
 * tailnet URL) plus both schemes of the tailnet name. Never derived from the
 * request's own Host or Origin. Managed computers authenticate each browser
 * socket with a token the page itself holds, and public self-hosting has no
 * configured browser origin, so neither enforces here.
 */
export function resolveWebSocketOriginPolicy(
  env: NodeJS.ProcessEnv,
  allowedOrigins: { resolve(origin: string | undefined): string | undefined },
): WebSocketOriginPolicy {
  const enforce = env.MATRIX_SELF_HOSTED === "1" && PRIVATE_ACCESS_MODES.has(env.MATRIX_ACCESS_MODE ?? "");
  const tailnet = new Set(enforce ? tailnetOrigins(env.MATRIX_TAILNET_URL) : []);
  return {
    enforce,
    isAllowed: (origin) => allowedOrigins.resolve(origin) === origin || tailnet.has(origin),
  };
}

function isWebSocketUpgrade(upgrade: string | undefined): boolean {
  return upgrade !== undefined && upgrade.toLowerCase() === "websocket";
}

/**
 * Registered before authentication. Browsers always send Origin on a
 * WebSocket handshake, so a request without one is not a browser page: CLI,
 * Electron main, mobile and machine clients keep working, and must still
 * authenticate. A browser Origin outside the policy is refused before the
 * upgrade is accepted, so no socket, attach or lease ever exists for it.
 */
export function createWebSocketOriginGate(policy: WebSocketOriginPolicy): MiddlewareHandler {
  return async (c, next) => {
    if (!policy.enforce || !isWebSocketUpgrade(c.req.header("upgrade"))) return next();
    const origin = c.req.header("origin");
    if (origin === undefined || policy.isAllowed(origin)) return next();
    // The Origin value is attacker-chosen; it is not logged.
    console.warn("[gateway] Refused a WebSocket upgrade from an untrusted browser origin");
    return c.json({ error: "Forbidden" }, 403);
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The same ambient bearer reaches ordinary HTTP routes, and CORS only hides a
 * cross-site response: a form post or no-cors fetch from another site still
 * runs a mutation (e.g. a terminal command) as the owner. So an unsafe method
 * must come from an allowed browser Origin. Browsers send Origin on every
 * non-GET/HEAD request; one without Origin is a non-browser client (CLI,
 * Electron main, machines), unless the browser marked it cross-site or
 * same-site through Sec-Fetch-Site. Safe methods stay with CORS, and OPTIONS
 * preflights reach the CORS middleware.
 */
export function createHttpMutationOriginGate(policy: WebSocketOriginPolicy): MiddlewareHandler {
  return async (c, next) => {
    if (!policy.enforce || SAFE_METHODS.has(c.req.method.toUpperCase())) return next();
    const origin = c.req.header("origin");
    if (origin === undefined) {
      const site = c.req.header("sec-fetch-site")?.toLowerCase();
      if (site !== "cross-site" && site !== "same-site") return next();
    } else if (policy.isAllowed(origin)) {
      return next();
    }
    // The Origin value is attacker-chosen; it is not logged.
    console.warn("[gateway] Refused a state-changing request from an untrusted browser origin");
    return c.json({ error: "Forbidden" }, 403);
  };
}

/** Every upgrade, not only /ws: the ingress also adds credentials on /api and others (e.g. a canvas socket). */
export function registerWebSocketOriginGate(app: Hono, policy: WebSocketOriginPolicy): void {
  app.use("*", createWebSocketOriginGate(policy));
}

/**
 * The gateway's browser-origin gates, first in the middleware chain: the
 * WebSocket Origin gate and the HTTP mutation Origin gate. They run before CORS
 * and auth (registerGatewayAccessMiddleware), so a refused request reaches
 * neither. CORS answers the same allowed origins.
 */
export function registerBrowserOriginGates(app: Hono, options: {
  env: NodeJS.ProcessEnv;
  allowedOrigins: { resolve(origin: string | undefined): string | undefined };
}): void {
  const policy = resolveWebSocketOriginPolicy(options.env, options.allowedOrigins);
  registerWebSocketOriginGate(app, policy);
  app.use("*", createHttpMutationOriginGate(policy));
}
