import type { Context } from 'hono';
import {
  applyNoStoreResponseHeaders,
  sanitizeProxyResponseHeaders,
} from './proxy-headers.js';

const POSTHOG_RELAY_TIMEOUT_MS = 10_000;
const POSTHOG_INGEST_HOST = 'https://eu.i.posthog.com';
const POSTHOG_ASSET_HOST = 'https://eu-assets.i.posthog.com';
const POSTHOG_RELAY_FORWARD_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'dnt',
  'origin',
  'referer',
  'user-agent',
]);

export interface PostHogRelayDependencies {
  logRouteError(route: string, err: unknown): void;
}

export function isPostHogRelayPath(path: string): boolean {
  return path === '/relay' || path.startsWith('/relay/');
}

function isPostHogAssetRelayPath(upstreamPath: string): boolean {
  return (
    upstreamPath === '/static' ||
    upstreamPath.startsWith('/static/') ||
    upstreamPath === '/array' ||
    upstreamPath.startsWith('/array/')
  );
}

function buildPostHogRelayHeaders(c: Context, upstream: URL): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(c.req.header())) {
    const lowerKey = key.toLowerCase();
    if (
      value &&
      (POSTHOG_RELAY_FORWARD_HEADERS.has(lowerKey) || lowerKey.startsWith('sec-ch-ua'))
    ) {
      headers.set(key, value);
    }
  }
  headers.set('host', upstream.host);
  headers.set('accept-encoding', 'identity');
  headers.set('connection', 'close');
  return headers;
}

export async function proxyPostHogRelay(
  c: Context,
  deps: PostHogRelayDependencies,
): Promise<Response> {
  const requestUrl = new URL(c.req.url);
  const upstreamPath = requestUrl.pathname.slice('/relay'.length) || '/';
  const upstreamBase = isPostHogAssetRelayPath(upstreamPath)
    ? POSTHOG_ASSET_HOST
    : POSTHOG_INGEST_HOST;
  const upstream = new URL(upstreamBase);
  upstream.pathname = upstreamPath;
  upstream.search = requestUrl.search;

  try {
    const response = await fetch(upstream.toString(), {
      method: c.req.method,
      headers: buildPostHogRelayHeaders(c, upstream),
      redirect: 'manual',
      signal: AbortSignal.timeout(POSTHOG_RELAY_TIMEOUT_MS),
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.blob(),
    });
    const responseHeaders = sanitizeProxyResponseHeaders(response.headers);
    if (!isPostHogAssetRelayPath(upstreamPath)) {
      applyNoStoreResponseHeaders(responseHeaders);
    }
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    deps.logRouteError('app-domain posthog relay proxy', err);
    const errorHeaders = new Headers();
    applyNoStoreResponseHeaders(errorHeaders);
    return new Response('Telemetry relay unavailable', {
      status: 502,
      headers: errorHeaders,
    });
  }
}
