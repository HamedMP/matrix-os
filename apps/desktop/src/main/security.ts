export interface WindowOpenRequest {
  url: string;
}

export interface WindowOpenResult {
  action: "deny";
}

export interface WindowOpenHandlerDeps {
  openExternal: (url: string) => Promise<void>;
}

const DESKTOP_WEB_PROTOCOLS = new Set(["http:", "https:"]);
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

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
  return Boolean(parsed && DESKTOP_WEB_PROTOCOLS.has(parsed.protocol) && allowedOrigins.has(parsed.origin));
}

export function isAllowedExternalUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl);
  return Boolean(parsed && EXTERNAL_PROTOCOLS.has(parsed.protocol));
}

export function createWindowOpenHandler(deps: WindowOpenHandlerDeps) {
  return async (request: WindowOpenRequest): Promise<WindowOpenResult> => {
    const parsed = parseUrl(request.url);
    if (parsed && isAllowedExternalUrl(parsed.toString())) {
      try {
        await deps.openExternal(parsed.toString());
      } catch (err: unknown) {
        console.warn("[desktop] Failed to open external URL", err instanceof Error ? err.name : "UnknownError");
      }
    }
    return { action: "deny" };
  };
}
