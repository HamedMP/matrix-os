/**
 * Clerk satellite domains of the Matrix OS Clerk application. A visitor who
 * signs in from one of them is sent to the Matrix primary domain with a
 * `redirect_url` back to the satellite page; Matrix may send them back only to
 * these exact https origins (no wildcards, no subdomains, no other ports).
 */
export const CLERK_SATELLITE_RETURN_ORIGINS = ["https://ai-insights.app", "https://matrix.page"] as const;

/**
 * Matrix.page serves many publications and their frames/assets/data routes, so a
 * sign-in may only return to one canonical shared app: `/<publication-uuid>`,
 * optionally with Clerk's sync query (spec 2691 amendment, AL-2).
 */
const SATELLITE_RETURN_PATHS: Partial<Record<(typeof CLERK_SATELLITE_RETURN_ORIGINS)[number], RegExp>> = {
  "https://matrix.page": /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[?#]|$)/,
};

const MAX_SATELLITE_RETURN_LENGTH = 2_048;
// Anything a URL parser might silently rewrite (whitespace, control
// characters, backslashes) is refused so browser and server cannot disagree.
const UNSAFE_URL_CHARACTERS = /[\s\\\u0000-\u001f\u007f]/;

/** Exact satellite return address with its path, query and fragment, or null. */
export function clerkSatelliteReturnTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SATELLITE_RETURN_LENGTH) {
    return null;
  }
  if (UNSAFE_URL_CHARACTERS.test(value) || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const origin = CLERK_SATELLITE_RETURN_ORIGINS.find((allowed) => allowed === url.origin);
  if (!origin) return null;
  // The raw text must also start with the exact origin, so userinfo, explicit
  // ports, case or percent-encoding tricks that normalize to it are refused.
  const rest = value.slice(origin.length);
  if (!value.startsWith(origin) || (rest !== "" && !/^[/?#]/.test(rest))) return null;
  const pathRule = SATELLITE_RETURN_PATHS[origin];
  if (pathRule && (!pathRule.test(rest) || !pathRule.test(url.pathname))) return null;
  return url.href;
}

const PUBLISHABLE_KEY = /^pk_(live|test)_([A-Za-z0-9+/=_-]+)$/;
const FRONTEND_API_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch (err: unknown) {
    console.warn("[auth] Clerk publishable key decode failed:", err instanceof Error ? err.name : typeof err);
    return null;
  }
}

/**
 * Clerk's `allowedRedirectOrigins` for the primary app. Clerk replaces its own
 * defaults (the Frontend API's registrable domain and its subdomains, plus the
 * Frontend API itself in development) whenever this list is set, so those
 * defaults are rebuilt here and only the exact satellite origins are added.
 * Same-origin redirects are always allowed by Clerk. Returns undefined, which
 * leaves Clerk's defaults in place, when the key cannot be read.
 */
export function clerkAllowedRedirectOrigins(publishableKey: string | undefined): string[] | undefined {
  const match = PUBLISHABLE_KEY.exec(publishableKey ?? "");
  if (!match) return undefined;
  const decoded = decodeBase64(match[2]);
  if (!decoded || !decoded.endsWith("$")) return undefined;
  const frontendApi = decoded.slice(0, -1);
  if (!FRONTEND_API_HOST.test(frontendApi) || !frontendApi.includes(".")) return undefined;
  const registrableDomain = frontendApi.replace("clerk.", "");
  return [
    `https://${registrableDomain}`,
    `https://*.${registrableDomain}`,
    ...(match[1] === "test" ? [`https://${frontendApi}`] : []),
    ...CLERK_SATELLITE_RETURN_ORIGINS,
  ];
}
