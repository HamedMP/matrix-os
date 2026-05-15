export interface WindowOpenRequest {
  url: string;
}

export interface WindowOpenResult {
  action: "deny";
}

export interface ExternalOpenDeps {
  openExternal: (url: string) => Promise<void>;
}

export interface WindowOpenHandlerDeps extends ExternalOpenDeps {
  openAuthUrl?: (url: string) => Promise<void> | void;
}

const DESKTOP_WEB_PROTOCOLS = new Set(["http:", "https:"]);
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const DESKTOP_AUTH_ORIGINS = new Set([
  "https://accounts.google.com",
  "https://clerk.matrix-os.com",
  "https://app.matrix-os.com",
  "http://localhost:3001",
]);
const DESKTOP_AUTH_HOST_SUFFIXES = [".clerk.accounts.dev"];

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch (err: unknown) {
    if (err instanceof TypeError) {
      return null;
    }
    console.warn("[desktop] Unexpected URL parse failure", err instanceof Error ? err.name : "UnknownError");
    return null;
  }
}

export function normalizeMatrixDesktopUrl(rawUrl: string): string {
  const parsed = parseUrl(rawUrl);
  if (!parsed || !DESKTOP_WEB_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Invalid desktop URL");
  }
  return parsed.toString();
}

export function isAllowedShellNavigation(rawUrl: string, allowedOrigins: ReadonlySet<string>): boolean {
  const parsed = parseUrl(rawUrl);
  return Boolean(
    parsed &&
    DESKTOP_WEB_PROTOCOLS.has(parsed.protocol) &&
    (allowedOrigins.has(parsed.origin) || isAllowedDesktopAuthNavigation(parsed.toString())),
  );
}

export function isAllowedExternalUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl);
  return Boolean(parsed && EXTERNAL_PROTOCOLS.has(parsed.protocol));
}

export function isAllowedDesktopAuthNavigation(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed || !DESKTOP_WEB_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }
  if (DESKTOP_AUTH_ORIGINS.has(parsed.origin)) {
    return true;
  }
  return parsed.protocol === "https:" && DESKTOP_AUTH_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
}

export async function openAllowedExternalUrl(rawUrl: string, deps: ExternalOpenDeps): Promise<boolean> {
  const parsed = parseUrl(rawUrl);
  if (!parsed || !isAllowedExternalUrl(parsed.toString())) {
    return false;
  }
  try {
    await deps.openExternal(parsed.toString());
    return true;
  } catch (err: unknown) {
    console.warn("[desktop] Failed to open external URL", err instanceof Error ? err.name : "UnknownError");
    return false;
  }
}

export function createWindowOpenHandler(deps: WindowOpenHandlerDeps) {
  return async (request: WindowOpenRequest): Promise<WindowOpenResult> => {
    if (isAllowedDesktopAuthNavigation(request.url)) {
      await deps.openAuthUrl?.(request.url);
      return { action: "deny" };
    }
    await openAllowedExternalUrl(request.url, deps);
    return { action: "deny" };
  };
}
