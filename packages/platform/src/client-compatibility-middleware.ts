import type { MiddlewareHandler } from 'hono';
import { ClientTargetSchema, ClientVersionSchema, evaluateClientPolicy, type ClientPolicy, type ClientTarget } from '@matrix-os/contracts';

/** Compatibility hints are never an authentication boundary. Headerless legacy
 * clients remain supported until a bridge release can identify them reliably. */
export function clientCompatibilityMiddleware(readPolicy: (target: ClientTarget) => Promise<ClientPolicy | null>): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path.replace(/^\/vm\/[^/]+/, '');
    if (!path.startsWith('/api/') || path === '/api/system/info' || path.startsWith('/api/system/update') || path === '/api/system/upgrade' || c.req.method === 'OPTIONS') return next();
    const rawTarget = c.req.header('x-matrix-client-target'), rawVersion = c.req.header('x-matrix-client-version');
    if (!rawTarget && !rawVersion) return next();
    const target = ClientTargetSchema.safeParse(rawTarget), version = ClientVersionSchema.safeParse(rawVersion);
    if (!target.success || !version.success) return c.json({ error: 'Invalid client metadata' }, 400);
    let policy: ClientPolicy | null;
    try { policy = await readPolicy(target.data); }
    catch (err: unknown) {
      console.warn('[client-policy] API policy unavailable', err instanceof Error ? err.name : typeof err);
      // A control-plane outage is not evidence that the installed app is obsolete.
      return next();
    }
    if (evaluateClientPolicy(policy, version.data) === 'required') {
      c.header('cache-control', 'no-store');
      return c.json({ error: 'App update required', code: 'client_update_required', downloadUrl: policy!.downloadUrl, minSupportedVersion: policy!.minSupportedVersion }, 426);
    }
    return next();
  };
}
