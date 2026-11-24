import type { Context } from 'hono';
import { readCookie } from './session-cookies.js';

/**
 * Marks documents the platform's auth shell served (found during ENG-520): a
 * Next server action posted from such a page (Clerk's cache invalidation
 * after sign-in) must reach the auth shell that knows the action, not the
 * owner's runtime that may have become routable meanwhile. Short-lived,
 * HttpOnly, Lax; cleared when the runtime serves a document.
 */
export const PLATFORM_SHELL_DOCUMENT_COOKIE = 'matrix_platform_shell';
export const PLATFORM_SHELL_DOCUMENT_COOKIE_SET =
  `${PLATFORM_SHELL_DOCUMENT_COOKIE}=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
export const PLATFORM_SHELL_DOCUMENT_COOKIE_CLEAR =
  `${PLATFORM_SHELL_DOCUMENT_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function isHtmlDocumentResponse(method: string, headers: Headers): boolean {
  return method === 'GET' && (headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');
}

export function isPlatformShellServerAction(c: Context, cookieHeader: string | undefined): boolean {
  return isServerActionRequest(c) && !isExplicitVmPath(c.req.path)
    && readCookie(cookieHeader, PLATFORM_SHELL_DOCUMENT_COOKIE) === '1';
}

/**
 * Next answers an action id its build does not contain with this header
 * (status 409, the action did not run), so replaying the same request to the
 * other Next upstream is safe. The marker cookie is only a hint: it is shared
 * by every tab on the host, so either upstream may receive an action that
 * belongs to the other one.
 */
const NEXT_ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found';

export function isServerActionRequest(c: Context): boolean {
  return c.req.method === 'POST' && c.req.header('next-action') !== undefined;
}

export function isUnrecognizedServerActionResponse(response: Response): boolean {
  return response.headers.get(NEXT_ACTION_NOT_FOUND_HEADER) === '1';
}

/** Explicit `/vm/<handle>/...` pages are always runtime pages. */
export function isExplicitVmPath(path: string): boolean {
  return path.startsWith('/vm/');
}
