import { RuntimeSlotSchema } from './customer-vps-schema.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';

/**
 * The gateway scopes each app-session cookie to `/apps/<slug>/`. An explicit
 * computer route serves those same assets below `/vm/<handle>/...`, so the
 * browser would otherwise omit the cookie and the selected computer's app
 * document would fail authentication. Preserve the per-app scope while moving
 * only the matching gateway cookie onto the verified explicit route.
 */
export function scopeExplicitVmAppSessionCookie(
  headers: Headers,
  route: { handle: string; runtimeSlot?: string; upstreamPath: string },
): void {
  const match = route.upstreamPath.match(/^\/api\/apps\/([a-z0-9][a-z0-9-]{0,63})\/session$/);
  const slug = match?.[1];
  if (
    !slug
    || !HANDLE_PATTERN.test(route.handle)
    || (route.runtimeSlot !== undefined && !RuntimeSlotSchema.safeParse(route.runtimeSlot).success)
  ) return;

  const appPath = `/apps/${slug}/`;
  const routePrefix = route.runtimeSlot
    ? `/vm/${route.handle}/~runtime/${route.runtimeSlot}`
    : `/vm/${route.handle}`;
  const cookiePrefix = `matrix_app_session__${slug}=`;
  const cookies = headers.getSetCookie();
  let changed = false;
  const rewritten = cookies.map((cookie) => {
    if (!cookie.startsWith(cookiePrefix) || !cookie.includes(`Path=${appPath}`)) {
      return cookie;
    }
    changed = true;
    return cookie.replace(`Path=${appPath}`, `Path=${routePrefix}${appPath}`);
  });
  if (!changed) return;

  headers.delete('set-cookie');
  for (const cookie of rewritten) {
    headers.append('set-cookie', cookie);
  }
}
