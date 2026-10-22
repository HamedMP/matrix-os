import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { MANAGED_GOOGLE_ROUTE_CONTROL_PATH, ManagedGoogleRouteResolveRequestSchema, ManagedGoogleRouteResolveResponseSchema } from '@matrix-os/contracts';
import type { FundedRelayConfig } from './funded-relay-config.js';
import { buildCloudflareManagedGoogleRouteDescriptor } from './funded-google-route-descriptor.js';
import { ManagedRouteControlConfigError, parseManagedRouteControlConfig, type ManagedRouteControlConfig } from './managed-route-control-config.js';

const PREFIX = '/internal/google-managed-route';
const fail = (c: Context, status: 400 | 401 | 404 | 405 | 413 | 429 | 503) => c.json({ error: 'Managed route unavailable' }, status);
class Refused extends Error { constructor(readonly status: 400 | 413 | 503) { super('Managed route unavailable'); } }
async function readJson(c: Context, declared: number, signal: AbortSignal): Promise<unknown> {
  if (!c.req.raw.body) throw new Refused(400);
  const reader = c.req.raw.body.getReader(); const bytes = new Uint8Array(4096); let size = 0; let chunks = 0; let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(new Refused(503)); signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop(); });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]); if (part.done) break;
      if (++chunks > 64 || part.value.byteLength + size > bytes.byteLength) throw new Refused(413);
      bytes.set(part.value, size); size += part.value.byteLength;
    }
    if (signal.aborted) throw new Refused(503); if (size !== declared) throw new Refused(400);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) {
    void reader.cancel().catch(cleanupError => console.warn('[managed-route-control] Body cleanup:', cleanupError instanceof Error ? cleanupError.name : 'UnknownError'));
    if (error instanceof SyntaxError || error instanceof TypeError) throw new Refused(400);
    throw error;
  } finally { signal.removeEventListener('abort', stop); reader.releaseLock(); }
}

/** Private control resolver only. Config MUST be the same private immutable service snapshot used by actual
 * dispatch. No inference, lease, provider approval, host authority, owner/machine access or account-state probe. */
export function createManagedRouteControl(options: { config: FundedRelayConfig; settings: ManagedRouteControlConfig; now?: () => Date }) {
  const settings = parseManagedRouteControlConfig(options.settings); const config = options.config;
  if (!/^[\x21-\x7e]{32,4096}$/.test(config.relayControlToken)) throw new ManagedRouteControlConfigError();
  const expected = Buffer.from(config.relayControlToken); const now = options.now ?? (() => new Date());
  // No principal map. At most 8 bodies, each <=4 KiB/64 chunks/5 seconds, evicted in finally or shutdown.
  const active = new Set<AbortController>(); let closed = false; let count = 0; let windowAt = now().getTime();
  let drained = Promise.resolve(); let resolveDrained: (() => void) | undefined;
  const authorized = (header: string | undefined) => {
    if (!header || header.length > 4103) return false;
    const bearer = /^Bearer (\S+)$/i.exec(header)?.[1]; if (!bearer) return false;
    const supplied = Buffer.from(bearer); return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  return {
    register(app: Hono) {
      app.use(`${PREFIX}/*`, async (c, next) => {
        c.header('Cache-Control', 'no-store');
        if (!authorized(c.req.header('authorization'))) return fail(c, 401);
        if (closed) return fail(c, 503);
        await next();
      });
      const limit = bodyLimit({ maxSize: 4096, onError: c => fail(c, 413) });
      app.all(MANAGED_GOOGLE_ROUTE_CONTROL_PATH, async c => {
        if (c.req.method !== 'POST') return fail(c, 405);
        if (new URL(c.req.url).search || c.req.header('transfer-encoding') !== undefined
          || c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail(c, 400);
        const length = c.req.header('content-length'); if (!length || !/^\d{1,4}$/.test(length) || Number(length) < 1) return fail(c, 400);
        if (Number(length) > 4096) return fail(c, 413);
        const at = now().getTime(); if (!Number.isSafeInteger(at) || at < 0) return fail(c, 503);
        if (at - windowAt >= 60000) { count = 0; windowAt = at; }
        if (count >= 60 || active.size >= 8) return fail(c, 429); count++;
        const controller = new AbortController(); if (!active.size) drained = new Promise(resolve => { resolveDrained = resolve; }); active.add(controller);
        const timer = setTimeout(() => controller.abort(), 5000); timer.unref?.();
        const signal = AbortSignal.any([c.req.raw.signal, controller.signal]);
        try {
          return await limit(c, async () => {
            const body = ManagedGoogleRouteResolveRequestSchema.safeParse(await readJson(c, Number(length), signal));
            if (!body.success) { c.res = fail(c, 400); return; }
            const matches = settings.reviews.filter(review => review.relay.api === body.data.api && review.upstream.canonicalModelId === body.data.canonicalModelId);
            if (signal.aborted || closed || matches.length !== 1 || body.data.api !== 'openai-completions') { c.res = fail(c, 503); return; }
            const result = buildCloudflareManagedGoogleRouteDescriptor({ config, relayBaseUrl: settings.relayBaseUrl,
              api: body.data.api, modelId: body.data.canonicalModelId, review: matches[0], now: now() });
            if (!result) { c.res = fail(c, 503); return; }
            const encoded = JSON.stringify(ManagedGoogleRouteResolveResponseSchema.parse(result));
            if (signal.aborted || closed || Date.parse(result.descriptor.evidence.expiresAt) <= now().getTime() || Buffer.byteLength(encoded) > 65536) { c.res = fail(c, 503); return; }
            c.res = c.body(encoded, 200, { 'Content-Type': 'application/json' });
          }) ?? c.res;
        } catch (error) { return fail(c, error instanceof Refused ? error.status : 503); }
        finally { clearTimeout(timer); controller.abort(); active.delete(controller); if (!active.size) { resolveDrained?.(); resolveDrained = undefined; } }
      });
      app.all(`${PREFIX}/*`, c => fail(c, 404));
    },
    async close() { closed = true; for (const controller of active) controller.abort(); await drained; },
  };
}
