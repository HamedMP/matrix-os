export const UPSTREAM_TIMEOUT_MS = 30_000;
const WORKER_BODY_LIMIT = 10 * 1024 * 1024;
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
  const body = await readRequestBody(request);
  if (body instanceof Response) return body;
  const upstreamRequest = buildPlatformRequest(request, upstreamUrl, url.host, edgeSecret, body);

  let response: Response;
  try {
    response = await fetch(upstreamRequest, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const status = isTimeoutError(err) ? 504 : 502;
    console.error(`[edge-router] upstream_${status === 504 ? "timeout" : "failure"}`);
    return new Response("upstream unavailable", {
      status,
      headers: noStoreTextHeaders(),
    });
  }

  return withEdgeHeaders(response);
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

async function readRequestBody(request: Request): Promise<ArrayBuffer | null | Response> {
  if (request.method === "GET" || request.method === "HEAD") return null;

  const contentLength = Number(request.headers.get("content-length") ?? NaN);
  if (!Number.isNaN(contentLength) && contentLength > WORKER_BODY_LIMIT) {
    return payloadTooLargeResponse();
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > WORKER_BODY_LIMIT) {
    return payloadTooLargeResponse();
  }
  return body;
}

function withEdgeHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("cdn-cache-control", "no-store");
  const isWebSocketUpgrade = response.status === 101;

  return new Response(isWebSocketUpgrade ? null : response.body, buildEdgeResponseInit(response, headers));
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
  });
}

const worker = {
  fetch: handleEdgeRouterRequest,
};

export default worker;
