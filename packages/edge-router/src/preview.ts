import { buildEdgeResponseInit } from './index.js';
import { redirectPreviewLocation } from './slack-pilot.js';

const PREVIEW_HOST = /^pr-([1-9][0-9]{0,8})\.preview\.matrix-os\.com$/;
const PREVIEW_BODY_LIMIT = 10 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 30_000;
const STREAMING_PATH = /(?:^|\/)api\/(?:chats\/events|files\/media)$/;

export interface PreviewEdgeEnv {
  PREVIEW_PLATFORM_ORIGIN?: string;
  PREVIEW_EDGE_MASTER_SECRET?: string;
  /** Owner-approved legacy identity exception; never enables the wildcard Preview route. */
  PREVIEW_LEGACY_PUBLIC_ORIGIN?: string;
  PREVIEW_LEGACY_NOT_AFTER?: string;
  PREVIEW_LEGACY_EDGE_SECRET?: string;
}

function legacyConfiguration(env: PreviewEdgeEnv): { publicOrigin: string; prNumber: string; secret: string } | null {
  try {
    const url = new URL(env.PREVIEW_LEGACY_PUBLIC_ORIGIN ?? '');
    const prNumber = /^pr-([1-9][0-9]{0,8})-preview\.matrix-os\.com$/.exec(url.hostname)?.[1];
    const expiry = env.PREVIEW_LEGACY_NOT_AFTER ?? '';
    const remaining = Date.parse(expiry) - Date.now();
    const secret = env.PREVIEW_LEGACY_EDGE_SECRET ?? '';
    if (!prNumber || url.protocol !== 'https:' || url.username || url.password || url.port
      || url.pathname !== '/' || url.search || url.hash
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry)
      || !Number.isFinite(remaining) || remaining <= 0 || remaining > 4 * 60 * 60 * 1000
      || !/^[\x21-\x7e]{32,256}$/.test(secret)) return null;
    return { publicOrigin: url.origin, prNumber, secret };
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
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
  const legacyConfigured = [env.PREVIEW_LEGACY_PUBLIC_ORIGIN, env.PREVIEW_LEGACY_NOT_AFTER,
    env.PREVIEW_LEGACY_EDGE_SECRET].some(value => value !== undefined);
  const legacy = legacyConfigured ? legacyConfiguration(env) : null;
  if (legacyConfigured && !legacy) return unavailable();
  const preview = legacy ? (url.origin === legacy.publicOrigin ? { prNumber: legacy.prNumber } : null)
    : classifyPreviewHost(url.hostname);
  if (!preview) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const vmRoute = /^\/vm\/([^/]+)/.exec(url.pathname);
  if (vmRoute && vmRoute[1] !== `pr-${preview.prNumber}`) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  if (legacy) {
    const runtime = /^\/vm\/[^/]+\/~runtime\/([^/]+)/.exec(url.pathname)?.[1];
    if ((runtime && runtime !== `pr-${preview.prNumber}`)
      || url.searchParams.getAll('runtime').some(value => value !== `pr-${preview.prNumber}`)) {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
  }
  if (url.protocol !== 'https:') return unavailable();
  if (legacy && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.has('cookie')
    && request.headers.get('origin') !== legacy.publicOrigin) {
    return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
  }

  const origin = taggedPreviewOrigin(env.PREVIEW_PLATFORM_ORIGIN, preview.prNumber);
  const masterSecret = env.PREVIEW_EDGE_MASTER_SECRET?.trim();
  if (!origin || (!legacy && (!masterSecret || masterSecret.length < 32))) return unavailable();
  const secret = legacy?.secret ?? await previewEdgeSecret(masterSecret!, preview.prNumber);

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
  if (legacy) {
    for (const name of [...headers.keys()]) {
      if (name.startsWith('x-platform-') || name.startsWith('x-forwarded-') || name.startsWith('x-matrix-')) headers.delete(name);
    }
  }
  for (const name of ['host', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'x-matrix-edge-secret']) {
    headers.delete(name);
  }
  // Preserve the platform's existing preview-machine boundary for implicit routes.
  // The browser origin stays the approved alias; this trusted routing host cannot
  // fall back to the signed-in owner's primary machine.
  headers.set('x-forwarded-host', legacy ? `pr-${preview.prNumber}.preview.matrix-os.com` : url.hostname);
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
  const releaseTimeoutAfterHeaders = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    || (request.method === 'GET' && STREAMING_PATH.test(url.pathname));
  const headerController = new AbortController();
  const headerTimer = releaseTimeoutAfterHeaders
    ? setTimeout(() => headerController.abort(new DOMException('Header wait expired', 'TimeoutError')), PREVIEW_TIMEOUT_MS)
    : undefined;
  try {
    response = await fetch(upstream, {
      redirect: 'manual',
      signal: AbortSignal.any([
        request.signal,
        releaseTimeoutAfterHeaders ? headerController.signal : AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      ]),
    });
  } catch (error: unknown) {
    console.warn('[preview-edge] upstream unavailable:', error instanceof Error ? error.name : typeof error);
    return unavailable();
  } finally {
    if (headerTimer !== undefined) clearTimeout(headerTimer);
  }

  const responseHeaders = new Headers(response.headers);
  const location = responseHeaders.get('location');
  if (legacy && location) responseHeaders.set('location', redirectPreviewLocation(location, origin, legacy.publicOrigin));
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
