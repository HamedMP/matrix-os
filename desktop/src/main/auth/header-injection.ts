// Origin-scoped Authorization injection (FR-002/FR-003): the renderer never
// holds the credential; the trusted core attaches it at the network layer for
// the active gateway origin ONLY — and only on the renderer session. Embed
// partitions never get this hook (lesson L1: remote content can never ride the
// native principal).

interface WebRequestLike {
  onBeforeSendHeaders(
    listener: (
      details: { url: string; requestHeaders: Record<string, string> },
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void,
  ): void;
  onHeadersReceived(
    listener: (
      details: {
        url: string;
        method: string;
        responseHeaders?: Record<string, string[]>;
        resourceType?: string;
      },
      callback: (response: { responseHeaders?: Record<string, string[]>; statusLine?: string }) => void,
    ) => void,
  ): void;
}

interface SessionLike {
  webRequest: WebRequestLike;
}

function normalizeWsScheme(url: URL): string {
  if (url.protocol === "ws:") return "http:";
  if (url.protocol === "wss:") return "https:";
  return url.protocol;
}

export function shouldInjectAuth(requestUrl: string, gatewayOrigin: string | null): boolean {
  if (!gatewayOrigin) return false;
  let request: URL;
  let gateway: URL;
  try {
    request = new URL(requestUrl);
    gateway = new URL(gatewayOrigin);
  } catch {
    return false;
  }
  return (
    normalizeWsScheme(request) === normalizeWsScheme(gateway) &&
    request.hostname === gateway.hostname &&
    request.port === gateway.port
  );
}

function websocketOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizedHttpOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function uniq(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function isLocalDevRendererOrigin(origin: string): boolean {
  const normalized = normalizedHttpOrigin(origin);
  if (!normalized) return false;
  const url = new URL(normalized);
  return (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
    url.port.length > 0
  );
}

export function buildRendererCsp(gatewayOrigin: string | null, rendererOrigin: string): string {
  const gatewayHttpOrigin = normalizedHttpOrigin(gatewayOrigin);
  const rendererHttpOrigin = rendererOrigin === "null" ? null : normalizedHttpOrigin(rendererOrigin);
  const scriptSources = isLocalDevRendererOrigin(rendererOrigin) ? "'self' 'unsafe-inline'" : "'self'";
  const connectSources = uniq([
    "'self'",
    gatewayHttpOrigin,
    gatewayHttpOrigin ? websocketOrigin(gatewayHttpOrigin) : null,
    rendererHttpOrigin,
    rendererHttpOrigin ? websocketOrigin(rendererHttpOrigin) : null,
  ]).join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSources}`,
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    // blob: renders same-renderer object URLs (authenticated file previews);
    // it cannot reference external content.
    "img-src 'self' data: blob: https:",
  ].join("; ");
}

export function installHeaderInjection(
  rendererSession: SessionLike,
  getToken: () => string | null,
  getGatewayOrigin: () => string | null,
): void {
  rendererSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const token = getToken();
    if (token && shouldInjectAuth(details.url, getGatewayOrigin())) {
      details.requestHeaders["Authorization"] = `Bearer ${token}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

// The renderer (file:// in production, http://localhost in dev) is a different
// origin than the gateway, so its fetch() calls are cross-origin and the
// gateway does not send Access-Control-Allow-Origin for them. Since the trusted
// core owns the network layer, we inject CORS response headers for the gateway
// origin on the renderer session only — scoped to our own backend, never a
// server-side wildcard. Preflight OPTIONS are answered 200 so mutations pass.
export function installGatewayCors(
  rendererSession: SessionLike,
  getGatewayOrigin: () => string | null,
  rendererOrigin: string,
): void {
  rendererSession.webRequest.onHeadersReceived((details, callback) => {
    const gatewayOrigin = getGatewayOrigin();
    const isGatewayResponse = shouldInjectAuth(details.url, gatewayOrigin);
    const isRendererMainFrame = details.resourceType === "mainFrame" && (() => {
      try {
        return new URL(details.url).origin === rendererOrigin;
      } catch {
        return false;
      }
    })();

    if (!isGatewayResponse && !isRendererMainFrame) {
      callback({});
      return;
    }
    const responseHeaders: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      const lower = key.toLowerCase();
      if (
        lower !== "access-control-allow-origin" &&
        lower !== "access-control-allow-methods" &&
        lower !== "access-control-allow-headers" &&
        lower !== "access-control-allow-credentials" &&
        lower !== "content-security-policy"
      ) {
        responseHeaders[key] = value;
      }
    }
    if (isRendererMainFrame) {
      responseHeaders["Content-Security-Policy"] = [buildRendererCsp(gatewayOrigin, rendererOrigin)];
    }
    if (isGatewayResponse) {
      responseHeaders["Access-Control-Allow-Origin"] = [rendererOrigin];
      responseHeaders["Access-Control-Allow-Methods"] = ["GET, POST, PATCH, PUT, DELETE, OPTIONS"];
      responseHeaders["Access-Control-Allow-Headers"] = ["Authorization, Content-Type, x-runtime-slot"];
      responseHeaders["Access-Control-Allow-Credentials"] = ["true"];
    }
    if (isGatewayResponse && details.method === "OPTIONS") {
      callback({ responseHeaders, statusLine: "HTTP/1.1 200 OK" });
      return;
    }
    callback({ responseHeaders });
  });
}
