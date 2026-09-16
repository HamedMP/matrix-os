/**
 * Session routing helpers (shell paths, headers, failure responses).
 *
 * Extracted from ./session-routing-middleware.ts (Phase 1-A4). Pure move: no logic changes.
 */
import type { Context } from 'hono';
import { fonts, lightFg, palette, radii } from '@matrix-os/brand/tokens';
import { CLERK_SCRIPT_ORIGIN } from './auth-pages.js';
import type { AppDomainIdentity } from './session-routing-identity.js';

export function isPlatformRuntimeShellPath(path: string): boolean {
  return path === '/runtime' || path === '/onboarding/computer';
}


export function shouldServePlatformRuntimeShell(input: {
  isAppDomain: boolean;
  path: string;
  userId: string;
  identitySource?: AppDomainIdentity['source'];
}): boolean {
  return Boolean(
    input.isAppDomain &&
    input.userId &&
    isPlatformRuntimeShellPath(input.path) &&
    input.identitySource !== 'mobile-session' &&
    input.identitySource !== 'static-route'
  );
}



export function logCodeDomainUpstreamFailure(opts: {
  handle: string;
  runtimeSlot?: string | null;
  publicIPv4?: string | null;
  path: string;
  status: number;
}): void {
  console.warn(
    `[platform] code-domain vps upstream 5xx handle=${opts.handle} runtimeSlot=${opts.runtimeSlot ?? 'unknown'} publicIPv4=${opts.publicIPv4 ?? 'unknown'} path=${JSON.stringify(opts.path)} status=${opts.status}`,
  );
}


export function applyAuthPageHeaders(
  c: Context,
  scriptNonce: string,
  applyNoStoreHeaders: (c: Context) => void,
): void {
  applyNoStoreHeaders(c);
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    `frame-ancestors 'none'; script-src 'self' 'nonce-${scriptNonce}' ${CLERK_SCRIPT_ORIGIN} https://challenges.cloudflare.com; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'`,
  );
}


export function platformRuntimeShellUnavailableResponse(
  c: Context,
  applyNoStoreHeaders: (c: Context) => void,
): Response {
  const retryPath = isPlatformRuntimeShellPath(c.req.path) ? c.req.path : '/runtime';
  applyNoStoreHeaders(c);
  c.header('Retry-After', '5');
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  );
  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix OS temporarily unavailable</title>
  <style>
    :root { --font-instrument: 'Instrument Sans'; color-scheme: dark; font-family: ${fonts.sans}; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: ${palette.deep}; color: ${lightFg}; }
    main { width: min(32rem, calc(100% - 3rem)); text-align: center; }
    h1 { margin: 0 0 0.75rem; font-size: clamp(1.5rem, 5vw, 2.25rem); }
    p { margin: 0 0 1.5rem; color: ${palette.cream}; line-height: 1.6; }
    a { display: inline-block; border: 1px solid ${palette.subtle}; border-radius: ${radii.pill}; padding: 0.7rem 1.1rem; color: inherit; text-decoration: none; }
    a:focus-visible { outline: 3px solid ${palette.ember}; outline-offset: 3px; }
  </style>
</head>
<body>
  <main>
    <h1>Matrix OS shell unavailable</h1>
    <p>The computer setup shell could not be loaded. Please try again in a moment.</p>
    <a href="${retryPath}">Try again</a>
  </main>
</body>
</html>`, 503);
}