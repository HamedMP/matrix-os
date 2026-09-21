import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';

const callSchema = z.object({ service: z.string().min(1).max(100), action: z.string().min(1).max(100) });

/** Mount after handle HMAC verification, before any database or provider lookup.
 * Per-instance admission is deliberately conservative (8 in flight of 30 HTTP
 * slots). It is a bulkhead, not a globally consistent quota across Cloud Run.
 */
export function createInternalIntegrationGuard() {
  // At most 2048 authenticated handles, expired after 60s; oldest evicted at cap.
  const buckets = new Map<string, { tokens: number; at: number }>();
  let tokens = 20;
  let at = Date.now();
  let inFlight = 0;
  let admitted = 0;
  let limited = 0;
  let legacyRejected = 0;
  let reportedAt = at;
  const limitBody = bodyLimit({ maxSize: 65536 });

  const middleware: MiddlewareHandler = async (c, next) => {
    const handle = c.get('internalContainerHandle') as string | undefined;
    if (!handle) return c.json({ error: 'Unauthorized' }, 401);
    return limitBody(c, async () => {
      const now = Date.now();
      if (now - reportedAt >= 60_000) {
        console.info('[internal_integrations]', { admitted, limited, legacyRejected, inFlight });
        admitted = limited = legacyRejected = 0;
        reportedAt = now;
      }
      if (c.req.method === 'POST' && c.req.path.endsWith('/call')) {
        let body: unknown;
        try { body = await c.req.json(); }
        catch (error) {
          if (!(error instanceof SyntaxError)) console.warn('[internal_integrations] body_read_failed');
          c.res = c.json({ error: 'Invalid request' }, 400);
          return;
        }
        const parsed = callSchema.safeParse(body);
        if (!parsed.success) {
          c.res = c.json({ error: 'Invalid request' }, 400);
          return;
        }
        // Rollout compatibility tombstone, not a GraphQL text filter. Old clients
        // ignore Retry-After; reject the removed action before DB/account sync.
        if (parsed.data.service === 'linear' && parsed.data.action === 'graphql') {
          legacyRejected++;
          c.res = c.json({ error: 'Client upgrade required', code: 'unsupported_contract' }, 410);
          return;
        }
      }
      tokens = Math.min(20, tokens + Math.max(0, now - at) / 100);
      at = now;
      for (const [key, bucket] of buckets) if (now - bucket.at >= 60_000) buckets.delete(key);
      const bucket = buckets.get(handle) ?? { tokens: 10, at: now };
      bucket.tokens = Math.min(10, bucket.tokens + Math.max(0, now - bucket.at) / 500);
      bucket.at = now;
      if (inFlight >= 8 || tokens < 1 || bucket.tokens < 1) {
        limited++;
        c.res = c.json({ error: 'Please retry later', code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } });
        return;
      }
      if (!buckets.has(handle) && buckets.size >= 2048) buckets.delete(buckets.keys().next().value!);
      buckets.set(handle, bucket);
      bucket.tokens--;
      tokens--;
      inFlight++;
      admitted++;
      try { await next(); }
      finally { inFlight--; }
    });
  };
  return { middleware, snapshot: () => ({ inFlight, admitted, limited, legacyRejected, handles: buckets.size }) };
}
