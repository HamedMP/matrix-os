import type { Context } from 'hono';
import { fonts, lightFg, palette, radii } from '@matrix-os/brand/tokens';
import { escapeHtmlAttr } from './auth-pages.js';
import { canRouteMachineOnPreviewHost } from './customer-vps-preview.js';
import type { UserMachineRecord } from './db.js';
import {
  isCustomerVpsProxyMachineRoutable,
  type EntitlementAccessDecision,
} from './profile-routing.js';
import type { AppDomainIdentity } from './session-routing-identity.js';

// Shared destinations are the account-only collaboration entry (spec 535 M1).
// An account without a routable, entitled computer is served the platform
// shell for this path family instead of billing, provisioning or a boot page.
const SHARED_ENTRY_ROOT = '/shared';
const SHARED_ENTRY_MAX_SEGMENTS = 4;
const SHARED_ENTRY_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const SHARED_ENTRY_MAX_RETRY_TARGET_LENGTH = 2048;

export type SharedEntryTarget = 'vps' | 'platform';

export function isSharedEntryPath(path: string): boolean {
  if (path === SHARED_ENTRY_ROOT || path === `${SHARED_ENTRY_ROOT}/`) return true;
  if (!path.startsWith(`${SHARED_ENTRY_ROOT}/`)) return false;
  const segments = path.slice(SHARED_ENTRY_ROOT.length + 1).split('/');
  return segments.length <= SHARED_ENTRY_MAX_SEGMENTS
    && segments.every((segment) => SHARED_ENTRY_SEGMENT.test(segment));
}

export function isSharedEntryDocumentRequest(input: {
  isAppDomain: boolean;
  method: string;
  path: string;
}): boolean {
  return input.isAppDomain
    && (input.method === 'GET' || input.method === 'HEAD')
    && isSharedEntryPath(input.path);
}

/** Browser principals only: capability and mobile-session routes keep their own semantics. */
export function isSharedEntryIdentity(identity: AppDomainIdentity): boolean {
  return Boolean(identity.userId)
    && identity.source !== 'mobile-session'
    && identity.source !== 'static-route';
}

export function resolveSharedEntryTarget(input: {
  host: string;
  machine: UserMachineRecord | undefined;
  entitlement: EntitlementAccessDecision;
}): SharedEntryTarget {
  const { machine } = input;
  if (
    machine
    && isCustomerVpsProxyMachineRoutable(machine)
    && canRouteMachineOnPreviewHost(input.host, machine)
    && input.entitlement.runtimeProxyAllowed
  ) {
    return 'vps';
  }
  return 'platform';
}

function sharedEntryRetryTarget(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'https://app.matrix-os.com');
    const target = `${url.pathname}${url.search}`;
    if (isSharedEntryPath(url.pathname) && target.length <= SHARED_ENTRY_MAX_RETRY_TARGET_LENGTH) {
      return target;
    }
  } catch (err: unknown) {
    console.warn('[platform] Failed to parse shared entry retry URL:', err instanceof Error ? err.name : typeof err);
  }
  return SHARED_ENTRY_ROOT;
}

export function getSharedEntryUnavailablePage(retryTarget: string): string {
  const href = escapeHtmlAttr(retryTarget);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
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
  <main data-matrix-shared-entry-unavailable="true">
    <h1>Shared work is temporarily unavailable</h1>
    <p>Matrix could not load this page. It will try again in a few seconds.</p>
    <a href="${href}">Try again</a>
  </main>
</body>
</html>`;
}

/** Script-free 503 that keeps the requested destination; never redirects to billing. */
export function sharedEntryUnavailableResponse(
  c: Context,
  applyNoStoreHeaders: (c: Context) => void,
): Response {
  applyNoStoreHeaders(c);
  c.header('Retry-After', '5');
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  );
  return c.html(getSharedEntryUnavailablePage(sharedEntryRetryTarget(c.req.url)), 503);
}
