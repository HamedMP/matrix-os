const DEFAULT_PLATFORM_ORIGIN = "https://matrix-platform-jqxkjdhtkq-ey.a.run.app";
const UPSTREAM_TIMEOUT_MS = 10_000;

export type EdgeRouteClass = "platform" | "app" | "code" | "unknown";

export interface EdgeRouterEnv {
  PLATFORM_ORIGIN?: string;
}

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

  const platformOrigin = normalizePlatformOrigin(env.PLATFORM_ORIGIN ?? DEFAULT_PLATFORM_ORIGIN);
  if (!platformOrigin) {
    console.error("[edge-router] invalid_platform_origin");
    return new Response("upstream unavailable", {
      status: 503,
      headers: noStoreTextHeaders(),
    });
  }

  const upstreamUrl = `${platformOrigin}${url.pathname}${url.search}`;
  const upstreamRequest = await buildPlatformRequest(request, upstreamUrl, url.host);

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

  return withEdgeHeaders(response, routeClass);
}

async function buildPlatformRequest(
  request: Request,
  upstreamUrl: string,
  externalHost: string,
): Promise<Request> {
  const headers = new Headers(request.headers);
  const forwardedFor = sanitizeForwardedFor(headers.get("CF-Connecting-IP"));

  headers.delete("host");
  headers.delete("Host");
  headers.set("X-Forwarded-Host", externalHost);
  headers.set("X-Forwarded-Proto", "https");

  if (forwardedFor) {
    headers.set("X-Forwarded-For", forwardedFor);
  } else {
    headers.delete("X-Forwarded-For");
  }

  return new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer(),
    redirect: "manual",
  });
}

function withEdgeHeaders(response: Response, routeClass: EdgeRouteClass): Response {
  const headers = new Headers(response.headers);
  if (routeClass === "app" || routeClass === "code") {
    headers.set("cache-control", "no-store");
    headers.set("cdn-cache-control", "no-store");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
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
