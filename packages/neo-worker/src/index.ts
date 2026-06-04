const API_HOST = "eu.i.posthog.com";
const ASSET_HOST = "eu-assets.i.posthog.com";
const UPSTREAM_TIMEOUT_MS = 10_000;

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export function classifyPostHogProxyPath(pathname: string): "health" | "asset" | "ingest" {
  if (pathname === "/health") return "health";
  if (pathname.startsWith("/static/") || pathname.startsWith("/array/")) return "asset";
  return "ingest";
}

export async function handlePostHogProxyRequest(
  request: Request,
  _env: unknown,
  ctx: WorkerExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const routeClass = classifyPostHogProxyPath(url.pathname);

  if (routeClass === "health") {
    return new Response("ok", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const targetHost = routeClass === "asset" ? ASSET_HOST : API_HOST;
  const upstreamUrl = `https://${targetHost}${url.pathname}${url.search}`;
  const upstreamRequest = await buildPostHogUpstreamRequest(request, upstreamUrl);
  const response = await fetch(upstreamRequest, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (routeClass === "asset") {
    ctx.waitUntil(cacheAsset(request, response.clone()));
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, no-store, must-revalidate");
  headers.set("cdn-cache-control", "no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function buildPostHogUpstreamRequest(request: Request, upstreamUrl: string): Promise<Request> {
  const headers = new Headers(request.headers);
  const ip = sanitizeForwardedIp(headers.get("CF-Connecting-IP"));
  headers.delete("cookie");
  headers.delete("Cookie");
  if (ip) {
    headers.set("X-Forwarded-For", ip);
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

function sanitizeForwardedIp(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return /^[0-9A-Fa-f:.]+$/.test(trimmed) ? trimmed : null;
}

type WorkerCacheStorage = CacheStorage & { default?: Cache };

async function cacheAsset(request: Request, response: Response): Promise<void> {
  const cacheStorage = globalThis.caches as WorkerCacheStorage | undefined;
  const cacheApi = cacheStorage?.default;
  if (!cacheApi || request.method !== "GET" || !response.ok) return;
  await cacheApi.put(request, response);
}

const worker = {
  fetch: handlePostHogProxyRequest,
};

export default worker;
