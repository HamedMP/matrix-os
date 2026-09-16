/**
 * Auth page shared HTML helpers.
 *
 * Extracted from ./auth-pages.ts (Phase 1-A4). Pure move: no logic changes.
 */

import { normalizeDeviceReturnPath } from '../request-routing.js';

export const CLERK_SCRIPT_ORIGIN = 'https://clerk.matrix-os.com';
export const BROWSER_CLERK_SIGN_OUT_TIMEOUT_MS = 10_000;

export function deviceReturnTargetFromRedirectPath(redirectTarget: string): string {
  try {
    const url = new URL(redirectTarget, 'https://app.matrix-os.com');
    return normalizeDeviceReturnPath(url.searchParams.get('device_return')) ?? '';
  } catch (err: unknown) {
    console.warn('[platform] Failed to extract device return target:', err instanceof Error ? err.message : String(err));
    return '';
  }
}

export function buildBillingSetupTarget(appShellOrigin: string, redirectTarget: string): string {
  const url = new URL('/', appShellOrigin);
  url.searchParams.set('billing', 'setup');
  const deviceReturnTarget = deviceReturnTargetFromRedirectPath(redirectTarget);
  if (deviceReturnTarget) url.searchParams.set('device_return', deviceReturnTarget);
  return url.toString();
}

export function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

export function escapeHtml(value: string): string {
  return escapeHtmlAttr(value);
}

export function escapeInlineScriptJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
