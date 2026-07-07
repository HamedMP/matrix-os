import { createHmac } from 'node:crypto';
import {
  NATIVE_APP_SESSION_PROXY_HEADER,
  PLATFORM_SESSION_PROXY_HEADER,
} from './session-cookies.js';
import { timingSafeTokenEquals } from './platform-token.js';

export const EDGE_SECRET_HEADER = 'x-matrix-edge-secret';
export const APP_ASSET_ROUTE_TOKEN_PARAM = 'matrix_asset_token';
export const APP_ASSET_ROUTE_OMITTED_QUERY_PARAMS = [APP_ASSET_ROUTE_TOKEN_PARAM] as const;

const SENSITIVE_PROXY_HEADERS = new Set([
  'authorization',
  'cookie',
  EDGE_SECRET_HEADER,
  NATIVE_APP_SESSION_PROXY_HEADER,
  PLATFORM_SESSION_PROXY_HEADER,
  'x-matrix-code-proxy-token',
]);

export function applyCookieRoutedShellAssetCacheHeaders(headers: Headers): void {
  headers.set('cache-control', 'private, no-store');
  headers.set('cdn-cache-control', 'no-store');
  headers.set('cloudflare-cdn-cache-control', 'no-store');
  addVaryHeader(headers, ['Cookie', 'Accept-Encoding']);
}

export function applyAppDomainRuntimeAssetCacheHeaders(headers: Headers, path: string, rawUrl: string): void {
  const maxAge = getAppDomainRuntimeAssetBrowserMaxAge(path, rawUrl);
  if (maxAge === null) return;
  const immutable = maxAge === 31_536_000 ? ', immutable' : '';
  headers.set('cache-control', `private, max-age=${maxAge}${immutable}`);
  headers.set('cdn-cache-control', 'no-store');
  headers.set('cloudflare-cdn-cache-control', 'no-store');
  addVaryHeader(headers, ['Cookie', 'Accept-Encoding']);
}

function getAppDomainRuntimeAssetBrowserMaxAge(path: string, rawUrl: string): number | null {
  if (path.startsWith('/_next/static/') || isViteAppAssetPath(path)) return 31_536_000;
  if (path.startsWith('/icons/')) {
    try {
      return new URL(rawUrl, 'https://app.matrix-os.com').searchParams.has('v') ? 31_536_000 : 86_400;
    } catch (err: unknown) {
      console.warn('[platform] Failed to parse runtime asset cache URL:', err instanceof Error ? err.message : String(err));
      return 86_400;
    }
  }
  if (path.startsWith('/fonts/') || path.startsWith('/wallpapers/')) return 86_400;
  return null;
}

function addVaryHeader(headers: Headers, values: string[]): void {
  const vary = headers.get('vary');
  const varyParts = new Set(
    (vary ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
  for (const value of values) {
    varyParts.add(value);
  }
  headers.set('vary', Array.from(varyParts).join(', '));
}

export function applySandboxedAppAssetCorsHeaders(headers: Headers, path: string, origin: string | undefined): void {
  if (!isViteAppAssetPath(path) || origin !== 'null') return;
  // Runtime apps execute from a sandboxed srcdoc iframe with an opaque null
  // origin. Asset requests use explicit /vm/{handle}/apps/... URLs so they do
  // not need relaxed SameSite cookies to cross that sandbox boundary.
  headers.set('access-control-allow-origin', 'null');
  headers.set('access-control-allow-credentials', 'true');
  addVaryHeader(headers, ['Origin']);
}

export function isCodeDomainStaticAssetPath(path: string): boolean {
  return (
    path === '/favicon.ico' ||
    path.startsWith('/_static/') ||
    /^\/stable-[^/]+\/static\//.test(path)
  );
}

export function isAppDomainStaticAssetPath(path: string): boolean {
  return (
    path === '/favicon.ico' ||
    path === '/icon.png' ||
    path === '/manifest.json' ||
    path === '/og.png' ||
    path.startsWith('/_next/static/') ||
    path.startsWith('/_next/image') ||
    path.startsWith('/fonts/') ||
    path.startsWith('/wallpapers/') ||
    isViteAppAssetPath(path)
  );
}

export function isViteAppAssetPath(path: string): boolean {
  return /^\/apps\/[a-z0-9][a-z0-9-]{0,63}\/assets\/.+/.test(path);
}

export function getViteAppAssetSlug(path: string): string | null {
  const match = path.match(/^\/apps\/([a-z0-9][a-z0-9-]{0,63})\/assets\/.+/);
  return match?.[1] ?? null;
}

export function hasValidExplicitVmAppAssetToken(input: {
  method: string;
  rawUrl: string;
  route: { handle: string; upstreamPath: string };
  platformSecret: string;
}): boolean {
  if (input.method !== 'GET' && input.method !== 'HEAD') return false;
  const slug = getViteAppAssetSlug(input.route.upstreamPath);
  if (!slug) return false;
  try {
    const url = new URL(input.rawUrl, 'https://app.matrix-os.com');
    return verifyAppAssetRouteToken({
      token: url.searchParams.get(APP_ASSET_ROUTE_TOKEN_PARAM),
      expectedHandle: input.route.handle,
      expectedSlug: slug,
      platformSecret: input.platformSecret,
    });
  } catch (err: unknown) {
    console.warn('[platform] Failed to parse explicit VM asset URL:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

function getViteAppHtmlSlug(path: string): string | null {
  const match = path.match(/^\/apps\/([a-z0-9][a-z0-9-]{0,63})(?:\/(?:index\.html)?)?$/);
  return match?.[1] ?? null;
}

interface AppAssetRouteTokenPayload {
  v: 1;
  handle: string;
  slug: string;
}

function signAppAssetRouteToken(
  payload: AppAssetRouteTokenPayload,
  platformSecret: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', platformSecret)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function buildAppAssetRouteToken(
  handle: string,
  slug: string,
  platformSecret: string,
): string {
  // Vite can lazy-load chunks long after initial HTML render, and browser
  // module imports cannot refresh query tokens without a full page reload. The
  // token therefore gates static app bundle assets by handle+slug, not time.
  return signAppAssetRouteToken({
    v: 1,
    handle,
    slug,
  }, platformSecret);
}

export function verifyAppAssetRouteToken(input: {
  token: string | null;
  expectedHandle: string;
  expectedSlug: string;
  platformSecret: string;
}): boolean {
  if (!input.token || !input.platformSecret) return false;
  const [encodedPayload, signature, extra] = input.token.split('.');
  if (!encodedPayload || !signature || extra !== undefined) return false;
  const expectedSignature = createHmac('sha256', input.platformSecret)
    .update(encodedPayload)
    .digest('base64url');
  if (!timingSafeTokenEquals(signature, expectedSignature)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<AppAssetRouteTokenPayload>;
    return (
      parsed.v === 1 &&
      parsed.handle === input.expectedHandle &&
      parsed.slug === input.expectedSlug
    );
  } catch (err: unknown) {
    console.warn('[platform] Failed to parse app asset route token:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function appendQueryParamToPath(path: string, key: string, value: string): string {
  const hashStart = path.indexOf('#');
  const pathAndQuery = hashStart === -1 ? path : path.slice(0, hashStart);
  const hash = hashStart === -1 ? '' : path.slice(hashStart);
  const separator = pathAndQuery.includes('?') ? '&' : '?';
  return `${pathAndQuery}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}

export function readAppAssetRouteToken(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl, 'https://app.matrix-os.com');
    return url.searchParams.get(APP_ASSET_ROUTE_TOKEN_PARAM);
  } catch (err: unknown) {
    console.warn('[platform] Failed to read app asset route token:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function rewriteSandboxedViteAppAssetUrls(
  html: string,
  handle: string,
  path: string,
  platformSecret: string,
): string {
  const slug = getViteAppHtmlSlug(path);
  if (!slug || !platformSecret) return html;
  const assetToken = buildAppAssetRouteToken(handle, slug, platformSecret);
  const appAssetPrefix = `/apps/${slug}/assets/`;
  const rewriteTag = (tag: string): string => tag.replace(
    /\b(src|href)=(["'])([^"']+)\2/g,
    (match: string, attr: string, quote: string, value: string) => {
      const assetRemainder = value.startsWith('./assets/')
        ? value.slice('./assets/'.length)
        : value.startsWith(appAssetPrefix)
          ? value.slice(appAssetPrefix.length)
          : null;
      if (!assetRemainder) return match;
      const explicitAssetPath = appendQueryParamToPath(
        `/vm/${handle}/apps/${slug}/assets/${assetRemainder}`,
        APP_ASSET_ROUTE_TOKEN_PARAM,
        assetToken,
      );
      return `${attr}=${quote}${explicitAssetPath}${quote}`;
    },
  );

  let rewritten = '';
  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart === -1) {
      rewritten += html.slice(cursor);
      break;
    }
    const tagEnd = html.indexOf('>', tagStart + 1);
    if (tagEnd === -1) {
      rewritten += html.slice(cursor);
      break;
    }
    rewritten += html.slice(cursor, tagStart);
    const tag = html.slice(tagStart, tagEnd + 1);
    const tagName = tag.match(/^<\s*([a-zA-Z][a-zA-Z0-9-]*)\b/)?.[1]?.toLowerCase();
    const shouldRewriteTag = tagName === 'script' || tagName === 'link';
    rewritten += shouldRewriteTag ? rewriteTag(tag) : tag;
    cursor = tagEnd + 1;

    if (tagName === 'script' && !/\/\s*>$/.test(tag)) {
      const scriptCloseStart = html.toLowerCase().indexOf('</script', cursor);
      if (scriptCloseStart === -1) continue;
      const scriptCloseEnd = html.indexOf('>', scriptCloseStart + '</script'.length);
      if (scriptCloseEnd === -1) continue;
      rewritten += html.slice(cursor, scriptCloseEnd + 1);
      cursor = scriptCloseEnd + 1;
    }
  }
  return rewritten;
}

function rewriteSandboxedViteJsAssetImports(js: string, assetToken: string | null): string {
  if (!assetToken) return js;
  return js.replace(
    /((?:\bimport\s*\(\s*)|(?:\bimport\s*)|(?:\b(?:import|export)[^"']*?\bfrom\s*))(["'])(\.\/[^"']+\.(?:js|css)(?:\?[^"'#]*)?(?:#[^"']*)?)\2/g,
    (match: string, prefix: string, quote: string, value: string) => {
      if (value.includes(`${APP_ASSET_ROUTE_TOKEN_PARAM}=`)) return match;
      return `${prefix}${quote}${appendQueryParamToPath(value, APP_ASSET_ROUTE_TOKEN_PARAM, assetToken)}${quote}`;
    },
  );
}

export async function buildAppDomainProxyResponse(input: {
  upstream: Response;
  responseHeaders: Headers;
  path: string;
  handle: string;
  platformSecret: string;
  assetRouteToken?: string | null;
}): Promise<Response> {
  if (getViteAppHtmlSlug(input.path) && input.responseHeaders.get('content-type')?.includes('text/html')) {
    const html = await input.upstream.text();
    input.responseHeaders.delete('content-length');
    return new Response(rewriteSandboxedViteAppAssetUrls(html, input.handle, input.path, input.platformSecret), {
      status: input.upstream.status,
      headers: input.responseHeaders,
    });
  }
  if (
    getViteAppAssetSlug(input.path) &&
    input.assetRouteToken &&
    input.responseHeaders.get('content-type')?.includes('javascript')
  ) {
    const js = await input.upstream.text();
    input.responseHeaders.delete('content-length');
    return new Response(rewriteSandboxedViteJsAssetImports(js, input.assetRouteToken), {
      status: input.upstream.status,
      headers: input.responseHeaders,
    });
  }
  return new Response(input.upstream.body, {
    status: input.upstream.status,
    headers: input.responseHeaders,
  });
}

export function buildCodeDomainProxyHeaders(
  requestHeaders: Record<string, string | undefined>,
  host: string,
  codeProxyToken?: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (shouldForwardProxyHeader(key, value)) {
      headers.set(key, value);
    }
  }
  if (codeProxyToken) {
    headers.set('x-matrix-code-proxy-token', codeProxyToken);
  }
  headers.set('host', host);
  headers.set('x-forwarded-host', host);
  headers.set('x-forwarded-proto', 'https');
  headers.set('connection', 'close');
  return headers;
}

export function shouldForwardProxyHeader(key: string, value: string | undefined): value is string {
  const lowerKey = key.toLowerCase();
  return lowerKey !== 'host' && !SENSITIVE_PROXY_HEADERS.has(lowerKey) && Boolean(value);
}
