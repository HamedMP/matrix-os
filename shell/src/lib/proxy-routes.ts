export function isPublicShellPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/manifest.json" ||
    pathname === "/og.png" ||
    pathname === "/favicon.ico" ||
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    pathname === "/sign-up" ||
    pathname.startsWith("/sign-up/")
  );
}

export function isGatewayProxyPath(pathname: string): boolean {
  return (
    pathname.startsWith("/gateway/") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/files/") ||
    pathname.startsWith("/modules/") ||
    pathname.startsWith("/apps/") ||
    pathname === "/ws" ||
    pathname.startsWith("/ws/")
  );
}

export function normalizeBrowserRouteTarget(target: string | string[] | undefined): string {
  const raw = Array.isArray(target) ? target.join("/") : target;
  const trimmed = raw?.trim().replace(/^\/+/, "") ?? "";
  if (!trimmed || trimmed === "about:blank") return "about:blank";
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).toString();
    }
    return new URL(`https://${trimmed}`).toString();
  } catch (error: unknown) {
    console.warn(
      "[shell/browser-route] Invalid Browser route target:",
      error instanceof Error ? error.message : String(error),
    );
    return "about:blank";
  }
}

export function buildBrowserStandaloneAppUrl(target: string | string[] | undefined, handoffToken?: string): string {
  const url = new URL("/apps/browser/", "https://matrix.local");
  url.searchParams.set("target", normalizeBrowserRouteTarget(target));
  url.searchParams.set("surface", "standalone");
  if (handoffToken) {
    url.searchParams.set("handoff", handoffToken);
  }
  return `${url.pathname}${url.search}`;
}
