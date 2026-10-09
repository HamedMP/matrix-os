export const UPSTREAM_TIMEOUT_MS = 30_000;
/** Request bodies are buffered up to this size; larger bodies get a 413. */
export const EDGE_WORKER_BODY_LIMIT = 10 * 1024 * 1024;
const ATS_MAIL_BODY_LIMIT = 32 * 1024 * 1024;
const EDGE_SECRET_HEADER = "X-Matrix-Edge-Secret";

export type EdgeRouteClass = "platform" | "app" | "code" | "unknown";

export interface EdgeRouterEnv {
  EDGE_ROUTER_SECRET?: string;
  PLATFORM_ORIGIN?: string;
}

export type EdgeResponseInit = ResponseInit & {
  webSocket?: WebSocket | null;
};

export function classifyEdgeRoute(host: string): EdgeRouteClass {
  const normalized = normalizeHost(host);
  if (normalized === "api.matrix-os.com") return "platform";
  if (normalized === "app.matrix-os.com") return "app";
  if (normalized === "code.matrix-os.com") return "code";
  return "unknown";
}

export async function handleEdgeRouterRequest(
  request: Request,
  env: EdgeRouterEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const routeClass = classifyEdgeRoute(url.host);
  if (routeClass === "unknown") {
    return new Response("not found", {
      status: 404,
      headers: noStoreTextHeaders(),
    });
  }

  const platformOrigin = env.PLATFORM_ORIGIN ? normalizePlatformOrigin(env.PLATFORM_ORIGIN) : null;
  if (!platformOrigin) {
    console.error("[edge-router] invalid_platform_origin");
    return new Response("upstream unavailable", {
      status: 503,
      headers: noStoreTextHeaders(),
    });
  }
  const edgeSecret = normalizeEdgeSecret(env.EDGE_ROUTER_SECRET);
  if (!edgeSecret) {
    console.error("[edge-router] missing_edge_secret");
    return new Response("upstream unavailable", {
      status: 503,
      headers: noStoreTextHeaders(),
    });
  }

  const upstreamUrl = `${platformOrigin}${url.pathname}${url.search}`;
  const bodyLimit = routeClass === "platform" && url.pathname === "/api/ats/mail"
    ? ATS_MAIL_BODY_LIMIT : EDGE_WORKER_BODY_LIMIT;
  const body = await readRequestBody(request, bodyLimit);
  if (body instanceof Response) return body;
  const upstreamRequest = buildPlatformRequest(request, upstreamUrl, url.host, edgeSecret, body);

  let response: Response;
  const streamDownload = request.method === "GET" && url.searchParams.get("download") === "true"
    && /^\/(?:vm\/[A-Za-z0-9_-]{1,64}\/(?:~runtime\/[A-Za-z0-9_-]{1,32}\/)?)?api\/files\/media$/.test(url.pathname);
  const headerController = new AbortController();
  const headerTimer = streamDownload
    ? setTimeout(() => headerController.abort(new DOMException("Header wait expired", "TimeoutError")), UPSTREAM_TIMEOUT_MS)
    : undefined;
  try {
    response = await fetch(upstreamRequest, {
      signal: streamDownload ? AbortSignal.any([request.signal, headerController.signal]) : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const status = isTimeoutError(err) ? 504 : 502;
    console.error(`[edge-router] upstream_${status === 504 ? "timeout" : "failure"}`);
    return new Response("upstream unavailable", {
      status,
      headers: noStoreTextHeaders(),
    });
  } finally {
    if (headerTimer !== undefined) clearTimeout(headerTimer);
  }

  return withEdgeHeaders(response, routeClass, url.pathname);
}

function buildPlatformRequest(
  request: Request,
  upstreamUrl: string,
  externalHost: string,
  edgeSecret: string,
  body: ArrayBuffer | null,
): Request {
  const headers = new Headers(request.headers);
  const forwardedFor = sanitizeForwardedFor(headers.get("CF-Connecting-IP"));

  headers.delete("host");
  headers.delete("Host");
  headers.set("X-Forwarded-Host", externalHost);
  headers.set("X-Forwarded-Proto", "https");
  headers.set(EDGE_SECRET_HEADER, edgeSecret);

  if (forwardedFor) {
    headers.set("X-Forwarded-For", forwardedFor);
  } else {
    headers.delete("X-Forwarded-For");
  }

  return new Request(upstreamUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
}

async function readRequestBody(request: Request, limit: number): Promise<ArrayBuffer | null | Response> {
  if (request.method === "GET" || request.method === "HEAD") return null;

  const contentLength = Number(request.headers.get("content-length") ?? NaN);
  if (!Number.isNaN(contentLength) && contentLength > limit) {
    return payloadTooLargeResponse();
  }

  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  let bytes = new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return size === bytes.length ? bytes.buffer : bytes.slice(0, size).buffer;
      if (chunk.value.byteLength > limit - size) {
        try { await reader.cancel(); }
        catch (error) { console.error("[edge-router] body_cancel_failed", error instanceof Error ? error.name : typeof error); }
        return payloadTooLargeResponse();
      }
      const nextSize = size + chunk.value.byteLength;
      if (nextSize > bytes.length) {
        const grown = new Uint8Array(Math.min(limit, Math.max(64 * 1024, bytes.length * 2, nextSize)));
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(chunk.value, size);
      size = nextSize;
    }
  } catch (error) {
    console.error("[edge-router] body_read_failed", error instanceof Error ? error.name : typeof error);
    return new Response("invalid request body", { status: 400, headers: noStoreTextHeaders() });
  } finally { reader.releaseLock(); }
}

function withEdgeHeaders(response: Response, routeClass: EdgeRouteClass, pathname: string): Response {
  const headers = new Headers(response.headers);
  if (shouldPreserveBrowserCache(routeClass, pathname, response)) {
    const upstreamCacheControl = headers.get("cache-control");
    headers.set("cache-control", upstreamCacheControl ?? browserCacheControlForAppStaticAsset(pathname));
  } else {
    headers.set("cache-control", /^attachment(?:;|$)/i.test(response.headers.get("content-disposition") ?? "") ? "no-store, no-transform" : "no-store");
  }
  headers.set("cdn-cache-control", "no-store");
  headers.set("cloudflare-cdn-cache-control", "no-store");
  const isWebSocketUpgrade = response.status === 101;

  return new Response(isWebSocketUpgrade ? null : response.body, buildEdgeResponseInit(response, headers));
}

function shouldPreserveBrowserCache(
  routeClass: EdgeRouteClass,
  pathname: string,
  response: Response,
): boolean {
  return routeClass === "app" && response.status >= 200 && response.status < 400 && isSafeAppStaticAssetPath(pathname);
}

function isSafeAppStaticAssetPath(pathname: string): boolean {
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/v1/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/sign-up") ||
    pathname.startsWith("/_next/data/") ||
    pathname.startsWith("/files/apps/")
  ) {
    return false;
  }

  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/wallpapers/") ||
    pathname.startsWith("/files/system/wallpapers/") ||
    pathname.startsWith("/textures/") ||
    pathname.startsWith("/fonts/") ||
    /\.(?:png|jpg|jpeg|svg|webp|woff2?|ttf|css|js|wav|mp3)$/.test(pathname)
  );
}

function browserCacheControlForAppStaticAsset(pathname: string): string {
  if (pathname.startsWith("/_next/static/")) return "public, max-age=31536000, immutable";
  if (pathname.startsWith("/icons/") || pathname.startsWith("/wallpapers/") || pathname.startsWith("/files/system/wallpapers/")) {
    return "public, max-age=86400, immutable";
  }
  return "public, max-age=86400";
}

export function buildEdgeResponseInit(response: Response, headers: Headers): EdgeResponseInit {
  const init: EdgeResponseInit = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
  if (response.status === 101) {
    init.webSocket = (response as Response & { webSocket?: WebSocket | null }).webSocket ?? null;
  }
  return init;
}

function payloadTooLargeResponse(): Response {
  return new Response("payload too large", {
    status: 413,
    headers: noStoreTextHeaders(),
  });
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

function normalizePlatformOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (err: unknown) {
    const kind = err instanceof Error ? err.name : typeof err;
    console.warn(`[edge-router] invalid platform origin: ${kind}`);
    return null;
  }
}

function normalizeEdgeSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sanitizeForwardedFor(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return /^[0-9A-Fa-f:.]+$/.test(trimmed) ? trimmed : null;
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

function noStoreTextHeaders(): Headers {
  return new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "cdn-cache-control": "no-store",
    "cloudflare-cdn-cache-control": "no-store",
  });
}

const worker = {
  fetch: handleEdgeRouterRequest,
};

export default worker;
