import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';

export const CODE_SESSION_COOKIE = 'matrix_code_session';
export const APP_SESSION_COOKIE = 'matrix_app_session';
export const NATIVE_APP_SESSION_COOKIE = 'matrix_native_app_session';
export const CLERK_SESSION_COOKIE = '__session';
export const CLERK_CLIENT_UAT_COOKIE = '__client_uat';
export const APP_ROUTE_COOKIE = 'matrix_app_route';
export const SHELL_ROUTE_COOKIE = 'matrix_shell_route';
export const SHELL_RUNTIME_SLOT_COOKIE = 'matrix_shell_runtime_slot';
export const CODE_SESSION_EXPIRES_IN_SEC = 12 * 60 * 60;
export const NATIVE_APP_SESSION_PROXY_HEADER = 'x-matrix-native-app-session';
export const PLATFORM_SESSION_PROXY_HEADER = 'x-matrix-platform-session';

const SAFE_CLERK_CLEAR_COOKIE_NAME = /^(?:__session|__client_uat)_[A-Za-z0-9_-]{1,128}$/;
const NATIVE_APP_SESSION_PROOF_PATTERN = /^[a-f0-9]{64}$/i;

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]+)`));
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch (err: unknown) {
    if (err instanceof URIError) {
      return null;
    }
    console.warn('[platform] Failed to decode cookie value:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function buildCodeSessionCookie(token: string): string {
  return [
    `${CODE_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${CODE_SESSION_EXPIRES_IN_SEC}`,
  ].join('; ');
}

export function buildAppSessionCookie(token: string): string {
  return [
    `${APP_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${CODE_SESSION_EXPIRES_IN_SEC}`,
  ].join('; ');
}

export function buildNativeAppSessionProof(token: string, platformJwtSecret: string): string {
  return createHmac('sha256', platformJwtSecret)
    .update(`native-app-session:${token}`)
    .digest('hex');
}

export function isValidNativeAppSessionProof(
  token: string | null | undefined,
  proof: string | null | undefined,
  platformJwtSecret: string,
): boolean {
  if (!token || !proof || !platformJwtSecret || !NATIVE_APP_SESSION_PROOF_PATTERN.test(proof)) {
    return false;
  }
  const expected = buildNativeAppSessionProof(token, platformJwtSecret);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'));
}

export function buildNativeAppSessionCookie(token: string, platformJwtSecret: string): string {
  return [
    `${NATIVE_APP_SESSION_COOKIE}=${buildNativeAppSessionProof(token, platformJwtSecret)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${CODE_SESSION_EXPIRES_IN_SEC}`,
  ].join('; ');
}

export function buildClearAppSessionCookie(): string {
  return [
    `${APP_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

export function buildClearNativeAppSessionCookie(): string {
  return [
    `${NATIVE_APP_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

export function buildClearShellRouteCookie(): string {
  return [
    `${SHELL_ROUTE_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

export function buildClearShellRuntimeSlotCookie(): string {
  return [
    `${SHELL_RUNTIME_SLOT_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

export function buildClearBrowserCookie(name: string, domain?: string): string {
  return [
    `${name}=`,
    'Path=/',
    ...(domain ? [`Domain=${domain}`] : []),
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

export function matrixCookieDomainForHost(hostHeader: string | undefined): string | null {
  const hostname = (hostHeader ?? '').split(':', 1)[0]?.toLowerCase() ?? '';
  if (hostname === 'matrix-os.com' || hostname.endsWith('.matrix-os.com')) {
    return 'matrix-os.com';
  }
  return null;
}

export function clerkCookieClearNames(cookieHeader: string | undefined): string[] {
  const names = new Set<string>([CLERK_SESSION_COOKIE, CLERK_CLIENT_UAT_COOKIE]);
  for (const part of (cookieHeader ?? '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equalsIndex = trimmed.indexOf('=');
    const name = equalsIndex === -1 ? trimmed : trimmed.slice(0, equalsIndex);
    if (SAFE_CLERK_CLEAR_COOKIE_NAME.test(name)) {
      names.add(name);
    }
  }
  return [...names];
}

export function appendSignOutClearCookies(c: Context): void {
  const cookieHeader = c.req.header('cookie');
  const domain = matrixCookieDomainForHost(c.req.header('host'));
  c.header('Set-Cookie', buildClearAppSessionCookie(), { append: true });
  c.header('Set-Cookie', buildClearNativeAppSessionCookie(), { append: true });
  c.header('Set-Cookie', buildClearShellRouteCookie(), { append: true });
  c.header('Set-Cookie', buildClearShellRuntimeSlotCookie(), { append: true });
  for (const name of clerkCookieClearNames(cookieHeader)) {
    c.header('Set-Cookie', buildClearBrowserCookie(name), { append: true });
    if (domain) {
      c.header('Set-Cookie', buildClearBrowserCookie(name, domain), { append: true });
    }
  }
}
