// Hosted-shell app-session handoff (FR-060/061). Encodes three paid-for
// lessons: L1 (embedded-surface auth never touches the native principal — this
// module has no access to the credential store and never escalates), L2 (BOTH
// session cookies must land or the handoff failed), L3 (stale Clerk cookies are
// cleared before installing the fresh pair).

export const REQUIRED_COOKIES = ["matrix_app_session", "matrix_native_app_session"] as const;

export interface ParsedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

function mapSameSite(value: string): ParsedCookie["sameSite"] {
  switch (value.toLowerCase()) {
    case "lax":
      return "lax";
    case "strict":
      return "strict";
    case "none":
      return "no_restriction";
    default:
      return "unspecified";
  }
}

function parseOne(header: string): ParsedCookie | null {
  // Electron's net response exposes set-cookie as a string[], so each header is
  // already a single cookie — no comma splitting (which would corrupt Expires).
  const parts = header.split(";");
  const first = (parts[0] ?? "").trim();
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  if (name.length === 0) return null;
  const value = first.slice(eq + 1);

  const cookie: ParsedCookie = { name, value };
  let maxAgeSeconds: number | null = null;

  for (let i = 1; i < parts.length; i += 1) {
    const attr = parts[i]!.trim();
    if (attr.length === 0) continue;
    const aeq = attr.indexOf("=");
    const key = (aeq === -1 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
    const val = aeq === -1 ? "" : attr.slice(aeq + 1).trim();
    switch (key) {
      case "path":
        cookie.path = val;
        break;
      case "domain":
        cookie.domain = val;
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite":
        cookie.sameSite = mapSameSite(val);
        break;
      case "expires": {
        const ts = Date.parse(val);
        if (!Number.isNaN(ts)) cookie.expires = ts;
        break;
      }
      case "max-age": {
        const n = Number(val);
        if (Number.isFinite(n)) maxAgeSeconds = n;
        break;
      }
      default:
        break;
    }
  }

  if (maxAgeSeconds !== null) cookie.expires = Date.now() + maxAgeSeconds * 1000;
  return cookie;
}

export function parseSetCookieHeaders(headers: string[]): ParsedCookie[] {
  const cookies: ParsedCookie[] = [];
  for (const header of headers) {
    const cookie = parseOne(header);
    if (cookie) cookies.push(cookie);
    else console.warn("[app-session] skipping malformed Set-Cookie header");
  }
  return cookies;
}

export function verifyCookiePair(cookies: ParsedCookie[]): boolean {
  return REQUIRED_COOKIES.every((name) =>
    cookies.some((cookie) => cookie.name === name && cookie.value.length > 0),
  );
}

export function isStaleClerkCookie(cookie: { name: string; domain?: string }): boolean {
  if (cookie.name.startsWith("__client") || cookie.name.startsWith("__session")) return true;
  if (cookie.domain && cookie.domain.toLowerCase().includes("clerk")) return true;
  return false;
}

export interface CookieJarLike {
  get(filter: Record<string, never>): Promise<Array<{ name: string; domain?: string; path?: string }>>;
  set(cookie: ParsedCookie & { url: string }): Promise<void>;
  remove(url: string, name: string): Promise<void>;
}

export interface HandoffDeps {
  request: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ status: number; setCookieHeaders: string[] }>;
  cookieJar: CookieJarLike;
  gatewayOrigin: string;
}

export type HandoffResult = { ok: true } | { ok: false; reason: "auth" | "unavailable" };

export async function performAppSessionHandoff(
  deps: HandoffDeps,
  redirectTo: string,
): Promise<HandoffResult> {
  let response: { status: number; setCookieHeaders: string[] };
  try {
    response = await deps.request(`${deps.gatewayOrigin}/api/auth/app-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirectTo }),
    });
  } catch (err: unknown) {
    console.warn(
      "[app-session] handoff request failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "unavailable" };
  }

  if (response.status === 401 || response.status === 403) return { ok: false, reason: "auth" };
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: "unavailable" };

  const cookies = parseSetCookieHeaders(response.setCookieHeaders);
  // L2: a single-cookie response is an auth failure, not a partial success.
  if (!verifyCookiePair(cookies)) return { ok: false, reason: "auth" };

  try {
    // L3: clear stale Clerk cookies before installing the fresh pair.
    const existing = await deps.cookieJar.get({});
    for (const cookie of existing) {
      if (isStaleClerkCookie(cookie)) await deps.cookieJar.remove(deps.gatewayOrigin, cookie.name);
    }
    for (const name of REQUIRED_COOKIES) {
      const cookie = cookies.find((c) => c.name === name);
      if (cookie) await deps.cookieJar.set({ ...cookie, url: deps.gatewayOrigin });
    }
  } catch (err: unknown) {
    console.warn(
      "[app-session] cookie installation failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "unavailable" };
  }

  return { ok: true };
}

export async function handoffWithRetry(
  deps: HandoffDeps,
  redirectTo: string,
): Promise<HandoffResult> {
  const first = await performAppSessionHandoff(deps, redirectTo);
  if (first.ok || first.reason === "auth") return first;
  // Exactly one retry on transient unavailability; never retry auth (L1).
  return performAppSessionHandoff(deps, redirectTo);
}
