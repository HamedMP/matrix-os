export interface PublicOriginRequestLike {
  headers: { get(name: string): string | null };
  nextUrl: {
    host: string;
    protocol: string;
  };
}

export function getConfiguredAppOrigin(
  configuredAppUrl: string | undefined = process.env.NEXT_PUBLIC_MATRIX_APP_URL,
): string | null {
  if (!configuredAppUrl || !URL.canParse(configuredAppUrl)) return null;
  const url = new URL(configuredAppUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

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
    request.nextUrl.protocol.replace(":", "");

  return `${proto}://${host}`;
}
