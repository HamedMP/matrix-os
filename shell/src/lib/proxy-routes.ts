const MAX_AUTH_REDIRECT_LENGTH = 2_048;
const MAX_AUTH_REDIRECT_SEARCH_LENGTH = 4_096;

export function isSignUpShellPath(pathname: string): boolean {
  return pathname === "/sign-up" || pathname.startsWith("/sign-up/");
}

function isAuthShellPath(pathname: string): boolean {
  return (
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    isSignUpShellPath(pathname)
  );
}

/**
 * Resolve Clerk's client-controlled post-signup destination without allowing
 * cross-origin redirects or loops back into an auth route. The path is kept
 * relative so callers choose the configured public origin explicitly.
 */
export function resolveCompletedSignupRedirect(search: string, appOrigin: string): string {
  if (search.length > MAX_AUTH_REDIRECT_SEARCH_LENGTH) return "/";
  const searchParams = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const requested = searchParams.get("redirect_url");
  if (!requested || requested.length > MAX_AUTH_REDIRECT_LENGTH) return "/";

  if (!URL.canParse(appOrigin)) return "/";
  const canonical = new URL(appOrigin);
  if (canonical.protocol !== "http:" && canonical.protocol !== "https:") return "/";

  const base = `${canonical.origin}/`;
  if (!URL.canParse(requested, base)) return "/";
  const destination = new URL(requested, base);
  if (destination.origin !== canonical.origin || destination.username || destination.password) {
    return "/";
  }
  if (isAuthShellPath(destination.pathname)) return "/";

  return `${destination.pathname}${destination.search}`;
}

export function isPublicShellPath(pathname: string, search = ""): boolean {
  const searchParams = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return (
    pathname === "/health" ||
    pathname === "/manifest.json" ||
    pathname === "/og.png" ||
    pathname === "/favicon.ico" ||
    pathname === "/runtime" ||
    pathname === "/onboarding/computer" ||
    (pathname === "/" && searchParams.get("billing") === "setup") ||
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    isSignUpShellPath(pathname)
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

const APP_SESSION_PATH = /^\/apps\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\/.*)?$/;
const MOBILE_SESSION_TOKEN = /^[A-Za-z0-9._~-]{1,4096}$/;

export function isPlatformMobileAppSessionRequest(
  pathname: string,
  search: string,
  cookieHeader: string | null,
): boolean {
  const match = APP_SESSION_PATH.exec(pathname);
  if (!match) return false;

  const slug = match[1];
  const searchParams = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const session = searchParams.get("session");
  if (session && MOBILE_SESSION_TOKEN.test(session)) return true;

  const sessionCookie = `matrix_app_session__${slug}=`;
  return (cookieHeader ?? "")
    .split(";")
    .some((part) => {
      const cookie = part.trim();
      if (!cookie.startsWith(sessionCookie)) return false;
      return MOBILE_SESSION_TOKEN.test(cookie.slice(sessionCookie.length));
    });
}
