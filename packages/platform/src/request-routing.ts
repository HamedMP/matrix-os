import { RuntimeSlotSchema } from './customer-vps-schema.js';

export const PLATFORM_SHELL_ASSET_PREFIX = '/__platform-shell';

const PLATFORM_SHELL_PUBLIC_ASSET_PATHS = [
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/logo-rabbit.png',
  '/manifest.json',
  '/matrix-logo.svg',
  '/og.png',
  '/runtime-shell-backdrop.webp',
] as const;

export function isPlatformShellAssetNamespacePath(path: string): boolean {
  return path === PLATFORM_SHELL_ASSET_PREFIX || path.startsWith(`${PLATFORM_SHELL_ASSET_PREFIX}/`);
}

export function getPlatformShellAssetUpstreamPath(path: string): string | null {
  if (!isPlatformShellAssetNamespacePath(path)) return null;
  const upstreamPath = path.slice(PLATFORM_SHELL_ASSET_PREFIX.length);
  let decodedPath = upstreamPath;
  for (let decodePass = 0; decodePass < 4; decodePass += 1) {
    try {
      const nextDecodedPath = decodeURIComponent(decodedPath);
      if (
        nextDecodedPath.includes('\\') ||
        nextDecodedPath.includes('\0') ||
        nextDecodedPath.split('/').some((segment) => segment === '.' || segment === '..')
      ) {
        return null;
      }
      if (nextDecodedPath === decodedPath) break;
      if (decodePass === 3) return null;
      decodedPath = nextDecodedPath;
    } catch (err: unknown) {
      if (!(err instanceof URIError)) {
        console.warn(
          '[platform] Unexpected platform shell asset path decode failure:',
          err instanceof Error ? err.name : typeof err,
        );
      }
      return null;
    }
  }
  if (
    (upstreamPath.startsWith('/_next/static/') && upstreamPath.length > '/_next/static/'.length) ||
    PLATFORM_SHELL_PUBLIC_ASSET_PATHS.some((assetPath) => assetPath === upstreamPath)
  ) {
    return upstreamPath;
  }
  return null;
}

type RuntimeSlotSource = 'query' | 'default';

export interface RuntimeSlotSelection {
  slot: string;
  source: RuntimeSlotSource;
}

export function readRuntimeSlotSelection(rawUrl: string): RuntimeSlotSelection {
  try {
    const querySlot = new URL(rawUrl, 'https://app.matrix-os.com').searchParams.get('runtime');
    if (querySlot && RuntimeSlotSchema.safeParse(querySlot).success) {
      return { slot: querySlot, source: 'query' };
    }
  } catch (err: unknown) {
    console.warn('[platform] Failed to parse runtime slot URL:', err instanceof Error ? err.message : String(err));
  }
  return { slot: 'primary', source: 'default' };
}

export function readRuntimeSlot(rawUrl: string): string {
  return readRuntimeSlotSelection(rawUrl).slot;
}

export function normalizeDeviceReturnPath(value: string | null): string | null {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) {
    return null;
  }
  try {
    const url = new URL(value, 'https://app.matrix-os.com');
    if (url.origin !== 'https://app.matrix-os.com' || url.pathname !== '/auth/device') return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (err: unknown) {
    console.warn('[platform] Failed to normalize device return path:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function buildForwardedQueryString(rawUrl: string, omittedParams: readonly string[] = []): string {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) return '';
  // Browser HTTP requests do not include fragments, but synthetic proxy tests
  // may pass raw URLs with hashes; never forward fragment text as query data.
  const hashStart = rawUrl.indexOf('#', queryStart);
  const rawQuery = rawUrl.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const forwarded = rawQuery
    .split('&')
    .filter((part) => {
      if (!part) return false;
      const rawKey = part.split('=', 1)[0] ?? '';
      // Decode the key before filtering so encoded variants such as
      // `%72untime=staging` cannot leak the platform-only runtime selector to
      // a customer VPS.
      const parsedKey = new URLSearchParams(`${rawKey}=`).keys().next().value ?? rawKey;
      return parsedKey !== 'runtime' && !omittedParams.includes(parsedKey);
    })
    .join('&');
  return forwarded ? `?${forwarded}` : '';
}

export function buildPostAuthRedirectPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'https://app.matrix-os.com');
    const normalizedPath = url.pathname.replace(/^\/{2,}/, '/');
    const path = /^\/sign-(?:in|up)(?:\/.*)?$/.test(normalizedPath) ? '/' : normalizedPath;
    const params = new URLSearchParams();
    const runtime = url.searchParams.get('runtime');
    if (runtime && RuntimeSlotSchema.safeParse(runtime).success) {
      params.set('runtime', runtime);
    }
    const deviceReturn = normalizeDeviceReturnPath(url.searchParams.get('device_return'));
    if (deviceReturn) params.set('device_return', deviceReturn);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  } catch (err: unknown) {
    console.warn('[platform] Failed to build post-auth redirect:', err instanceof Error ? err.message : String(err));
    return '/';
  }
}

export function normalizePostAuthRedirectPath(value: string | undefined): string {
  if (!value) return '/';
  try {
    const url = new URL(value, 'https://app.matrix-os.com');
    if (url.origin !== 'https://app.matrix-os.com') return '/';
    return buildPostAuthRedirectPath(url.toString());
  } catch (err: unknown) {
    console.warn('[platform] Failed to normalize app-session redirect:', err instanceof Error ? err.message : String(err));
    return '/';
  }
}

export function isAppDomainGatewayPath(path: string): boolean {
  return (
    path.startsWith('/api/') ||
    path.startsWith('/ws') ||
    path.startsWith('/files/') ||
    path.startsWith('/icons/') ||
    path.startsWith('/modules/') ||
    path === '/health'
  );
}

function isRuntimeDataPath(path: string): boolean {
  return (
    isAppDomainGatewayPath(path) ||
    path === '/apps' ||
    path.startsWith('/apps/')
  );
}

export function shouldProxyShellForBillingGate(input: {
  isAppDomain: boolean;
  method: string;
  upstreamPath: string;
}): boolean {
  return (
    input.isAppDomain &&
    (input.method === 'GET' || input.method === 'HEAD') &&
    !isRuntimeDataPath(input.upstreamPath)
  );
}

export function shouldProxyAuthShellForUnroutedUser(input: {
  isAppDomain: boolean;
  method: string;
  path: string;
}): boolean {
  return (
    input.isAppDomain &&
    (input.method === 'GET' || input.method === 'HEAD') &&
    !isRuntimeDataPath(input.path) &&
    !input.path.startsWith('/vps') &&
    !input.path.startsWith('/internal/') &&
    !input.path.startsWith('/billing/') &&
    input.path !== '/metrics'
  );
}

export function buildBillingSetupPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'https://app.matrix-os.com');
    const deviceReturn = url.searchParams.get('device_return');
    const target = new URL('/', url.origin);
    target.searchParams.set('billing', 'setup');
    if (deviceReturn) target.searchParams.set('device_return', deviceReturn);
    return `${target.pathname}${target.search}`;
  } catch (err: unknown) {
    console.warn('[platform] Failed to build billing setup URL:', err instanceof Error ? err.message : String(err));
    return '/?billing=setup';
  }
}

export function isBillingSetupPath(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, 'https://app.matrix-os.com');
    return url.pathname === '/' && url.searchParams.get('billing') === 'setup';
  } catch (err: unknown) {
    console.warn('[platform] Failed to parse billing setup URL:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function getAuthShellOrigin(env: NodeJS.ProcessEnv): string {
  const host = env.AUTH_SHELL_HOST?.trim() || '127.0.0.1';
  const port = env.AUTH_SHELL_PORT?.trim() || '3200';
  return `http://${host}:${port}`;
}
