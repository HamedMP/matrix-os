/**
 * Requests an export-only unit may serve (spec 2691, D3): at the monthly
 * compute cap an owner may still take their data out. The platform admits
 * only the owner export route and read-only file and Chat-history reads; the
 * gateway is expected to enforce the same mode on its side.
 */

export interface ExportRequestLike {
  method: string;
  path: string;
  header(name: string): string | undefined;
}

export const EXPORT_ROUTE = '/api/system/export';
const SEGMENT = '[A-Za-z0-9_-]{1,128}';
const READ_ROUTES: readonly RegExp[] = [
  /^\/api\/files\/(list|stat|tree|search)$/,
  /^\/files\/[^?#]{1,1024}$/,
  /^\/api\/chats(\/search)?$/,
  new RegExp(`^/api/chats/(?!events$|search$)${SEGMENT}$`),
  new RegExp(`^/api/conversations(/${SEGMENT})?$`),
];

function safePath(path: string): boolean {
  if (/%(2e|2f|5c)/i.test(path) || path.includes('\\')) return false;
  return !path.split('/').some((segment) => segment === '..' || segment === '.');
}

function isRead(request: ExportRequestLike): boolean {
  const method = request.method.toUpperCase();
  return (method === 'GET' || method === 'HEAD') && request.header('upgrade') === undefined;
}

/** The owner export request; the header is the export contract and keeps it out of plain navigations. */
export function isExportIntent(request: ExportRequestLike): boolean {
  return isRead(request) && request.path === EXPORT_ROUTE && request.header('x-matrix-export') === '1';
}

export function isExportOnlyRequest(request: ExportRequestLike): boolean {
  if (isExportIntent(request)) return true;
  if (!isRead(request) || !safePath(request.path)) return false;
  return READ_ROUTES.some((route) => route.test(request.path));
}
