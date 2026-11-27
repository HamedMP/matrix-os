import type { LaunchToken, LaunchTokenCache } from "./launch-token-cache";
import { nativeBrowserProduct } from "../../shared/browser-products";
import { browserProductLaunchUrl } from "./browser-product-launch";
import { resolveLaunchUrl } from "./origin-policy";

export class AppLaunchError extends Error {
  constructor(readonly state: "auth-required" | "failed") {
    super("App launch unavailable");
    this.name = "AppLaunchError";
  }
}

// Only a rejected owner credential asks for login. Policy, manifest, transport,
// and server failures must not send the user into a sign-in loop.
export async function requestAppLaunchToken(
  request: () => Promise<{ status: number; body: string }>,
): Promise<LaunchToken> {
  const response = await request();
  if (response.status === 401) throw new AppLaunchError("auth-required");
  if (response.status < 200 || response.status >= 300) {
    console.warn("[embed-service] app launch rejected:", response.status);
    throw new AppLaunchError("failed");
  }
  const parsed: unknown = JSON.parse(response.body);
  if (
    parsed && typeof parsed === "object" &&
    "launchUrl" in parsed && typeof parsed.launchUrl === "string" &&
    "expiresAt" in parsed && typeof parsed.expiresAt === "number" &&
    Number.isFinite(parsed.expiresAt) && parsed.expiresAt > Date.now()
  ) return { launchUrl: parsed.launchUrl, expiresAt: parsed.expiresAt };
  throw new AppLaunchError("failed");
}

export type AppLaunchResult =
  | { ok: true; url: string }
  | { ok: false; state: "auth-required" | "failed" };

export interface GatewayRequestInit { method: string; headers: Record<string, string>; body: string }
export type GatewayRequest = (url: string, init: GatewayRequestInit) => Promise<{ status: number; body: string }>;

/** The owner's session-token launch (`POST /api/apps/:slug/session-token`), shared by embeds and app windows. */
export function fetchAppLaunchToken(request: GatewayRequest, gatewayOrigin: string, slug: string): Promise<LaunchToken> {
  return requestAppLaunchToken(() => request(
    `${gatewayOrigin}/api/apps/${encodeURIComponent(slug)}/session-token`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  ));
}

/**
 * Turns a session-token launch into the URL a bridged app view may load: the
 * token's launch URL must be rooted and resolve to the gateway origin. Native
 * browser products are never cached and get their surface parameter.
 */
export async function resolveAppLaunchUrl(options: {
  gatewayOrigin: string;
  slug: string;
  appIdentity: string;
  fetchToken: () => Promise<LaunchToken>;
  cache?: LaunchTokenCache;
}): Promise<AppLaunchResult> {
  const { gatewayOrigin, slug, appIdentity } = options;
  const cache = nativeBrowserProduct(appIdentity, slug) ? undefined : options.cache;
  let token = cache?.get(slug) ?? null;
  if (!token) {
    try {
      token = await options.fetchToken();
    } catch (error: unknown) {
      console.warn("[embed-service] app launch failed:", error instanceof Error ? error.name : "UnknownError");
      return { ok: false, state: error instanceof AppLaunchError ? error.state : "failed" };
    }
    cache?.set(slug, token);
  }
  const initial = resolveLaunchUrl(token.launchUrl, gatewayOrigin);
  const resolved = initial ? browserProductLaunchUrl(initial, slug, appIdentity) : null;
  if (!resolved) {
    console.warn("[embed-service] app launch url failed origin check");
    cache?.delete(slug);
    return { ok: false, state: "failed" };
  }
  return { ok: true, url: resolved };
}
