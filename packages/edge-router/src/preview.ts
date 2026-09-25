import { buildEdgeResponseInit } from './index.js';

const PREVIEW_HOST = /^pr-([1-9][0-9]{0,8})\.preview\.matrix-os\.com$/;
const PREVIEW_BODY_LIMIT = 10 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 30_000;

export interface PreviewEdgeEnv {
  PREVIEW_PLATFORM_ORIGIN?: string;
  PREVIEW_EDGE_MASTER_SECRET?: string;
}

export function classifyPreviewHost(host: string): { prNumber: string } | null {
  const match = PREVIEW_HOST.exec(host.toLowerCase());
  return match ? { prNumber: match[1]! } : null;
}

function taggedPreviewOrigin(origin: string | undefined, prNumber: string): string | null {
  if (!origin) return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash
    || !/^matrix-platform-preview-[a-z0-9-]+\.a\.run\.app$/.test(parsed.hostname)) {
    return null;
  }
  return `https://pr-${prNumber}---${parsed.hostname}`;
}

function unavailable(): Response {
  return new Response('Preview unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
}

async function previewEdgeSecret(master: string, prNumber: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(master), {
    name: 'HMAC', hash: 'SHA-256',
  }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`matrix-preview-edge-v1:pr-${prNumber}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function boundedBody(request: Request): Promise<ArrayBuffer | null> {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > PREVIEW_BODY_LIMIT) throw new RangeError('body too large');
  if (!request.body) return null;
  const reader = request.body.getReader();
  let buffer = new Uint8Array(0);
  let length = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch((error: unknown) => {
      console.warn('[preview-edge] body cancellation failed:', error instanceof Error ? error.name : typeof error);
    });
  }, PREVIEW_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error('body timeout');
      if (done) break;
      if (value.byteLength > PREVIEW_BODY_LIMIT - length) throw new RangeError('body too large');
      const nextLength = length + value.byteLength;
      if (nextLength > buffer.byteLength) {
        const next = new Uint8Array(Math.min(PREVIEW_BODY_LIMIT, Math.max(nextLength, buffer.byteLength * 2, 1024)));
        next.set(buffer.subarray(0, length));
        buffer = next;
      }
      buffer.set(value, length);
      length = nextLength;
    }
    return buffer.slice(0, length).buffer;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function handlePreviewRequest(request: Request, env: PreviewEdgeEnv): Promise<Response> {
  const url = new URL(request.url);
  const preview = classifyPreviewHost(url.hostname);
  if (!preview) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const vmRoute = /^\/vm\/([^/]+)/.exec(url.pathname);
  if (vmRoute && vmRoute[1] !== `pr-${preview.prNumber}`) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  if (url.protocol !== 'https:') return unavailable();

  const origin = taggedPreviewOrigin(env.PREVIEW_PLATFORM_ORIGIN, preview.prNumber);
  const masterSecret = env.PREVIEW_EDGE_MASTER_SECRET?.trim();
  if (!origin || !masterSecret || masterSecret.length < 32) return unavailable();
  const secret = await previewEdgeSecret(masterSecret, preview.prNumber);

  let body: ArrayBuffer | null;
  try {
    body = await boundedBody(request);
  } catch (error) {
    if (error instanceof RangeError) {
      return new Response('Payload too large', { status: 413, headers: { 'cache-control': 'no-store' } });
    }
    return unavailable();
  }

  const headers = new Headers(request.headers);
  for (const name of ['host', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'x-matrix-edge-secret']) {
    headers.delete(name);
  }
  headers.set('x-forwarded-host', url.hostname);
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-matrix-edge-secret', secret);
  const ip = request.headers.get('cf-connecting-ip')?.trim();
  if (ip && ip.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(ip)) {
    headers.set('x-forwarded-for', ip);
  }

  const upstream = new Request(`${origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
  });
  let response: Response;
  try {
    response = await fetch(upstream, {
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(PREVIEW_TIMEOUT_MS)]),
    });
  } catch (error: unknown) {
    console.warn('[preview-edge] upstream unavailable:', error instanceof Error ? error.name : typeof error);
    return unavailable();
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('cache-control', 'no-store');
  responseHeaders.set('cdn-cache-control', 'no-store');
  responseHeaders.set('cloudflare-cdn-cache-control', 'no-store');
  for (const name of ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers', 'access-control-allow-methods']) {
    responseHeaders.delete(name);
  }
  // An unmerged PR must not set a cookie for production or sibling PR hosts.
  const cookieHeaders = response.headers as Headers & {
    getSetCookie?: () => string[];
    getAll?: (name: string) => string[];
  };
  const cookies = cookieHeaders.getSetCookie?.() ?? cookieHeaders.getAll?.('set-cookie') ?? [];
  responseHeaders.delete('set-cookie');
  for (const cookie of cookies) {
    if (!/;\s*domain\s*=/i.test(cookie)) responseHeaders.append('set-cookie', cookie);
  }
  return new Response(response.status === 101 ? null : response.body, buildEdgeResponseInit(response, responseHeaders));
}

export default { fetch: handlePreviewRequest };
