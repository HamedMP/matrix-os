export interface PublicOriginRequestLike {
  headers: { get(name: string): string | null };
  nextUrl: {
    host: string;
    protocol: string;
  };
}

/**
 * Origin of NEXT_PUBLIC_MATRIX_APP_URL, or null when unset/unparsable.
 *
 * In hosted deployments this is baked into the bundle at build time
 * (https://app.matrix-os.com), making it the canonical public origin. Local
 * dev leaves it unset and falls back to request-derived origins.
 */
export function getConfiguredAppOrigin(
  configuredAppUrl: string | undefined = process.env.NEXT_PUBLIC_MATRIX_APP_URL,
): string | null {
  if (!configuredAppUrl || !URL.canParse(configuredAppUrl)) return null;
  return new URL(configuredAppUrl).origin;
}

/**
 * Public origin for redirect URLs handed to Clerk and browsers.
 *
 * The configured app origin always wins: the auth shell sits behind the
 * platform proxy, which rewrites x-forwarded-proto to "http" (Next 16
 * self-proxy workaround), and Next 16 internal self-proxy hops re-enter the
 * proxy with the internal localhost origin and no forwarded headers. Deriving
 * the origin from those requests produces redirect URLs like
 * http://localhost:3200/?billing=setup, which Clerk rejects.
 */
export function getPublicOrigin(
  request: PublicOriginRequestLike,
  configuredAppUrl: string | undefined = process.env.NEXT_PUBLIC_MATRIX_APP_URL,
): string {
  const canonical = getConfiguredAppOrigin(configuredAppUrl);
  if (canonical) return canonical;

  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.nextUrl.host;
  const proto =
    request.headers.get("x-forwarded-proto") ??
    request.nextUrl.protocol.replace(":", "") ??
    "https";

  return `${proto}://${host}`;
}
