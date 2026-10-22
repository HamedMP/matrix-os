import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { GoogleQualifiedFundedDiscoveryRequestSchema, GoogleQualifiedFundedIssueRequestSchema, GoogleQualifiedFundedCheckRequestSchema, GoogleQualifiedFundedAuthorizationRequestSchema, GoogleQualifiedFundedDispatchCheckRequestSchema } from '@matrix-os/contracts';
import type { QualifiedFundedService } from './ai-funded-qualified-service.js';
import { timingSafeTokenEquals } from './platform-token.js';
import { QualifiedFundedError } from './ai-funded-qualified-errors.js';
import { QualifiedRuntimeAuthSchema } from './ai-funded-qualified-state.js';
type RouteEnv = { Variables: { qualifiedSignal: AbortSignal } };

const fail = (c: Context, status: 400 | 401 | 413 | 503) => c.json({ error: 'Qualified AI unavailable' }, status);
const Query = z.strictObject({ runtimeSlot: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/) });
function runtimeAuth(c: Context) {
  const query = Query.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!query.success) throw new QualifiedFundedError(400);
  const auth = QualifiedRuntimeAuthSchema.safeParse({ handle: c.req.param('handle'), runtimeSlot: query.data.runtimeSlot, authorization: c.req.header('authorization') ?? '' });
  if (!auth.success) throw new QualifiedFundedError(401); return auth.data;
}
function headers(c: Context): boolean {
  const length = c.req.header('content-length');
  return c.req.method === 'POST' && c.req.header('transfer-encoding') === undefined && c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
    && !!length && /^\d{1,4}$/.test(length) && Number(length) > 0;
}
async function json(c: Context<RouteEnv>): Promise<unknown> {
  const signal = c.get('qualifiedSignal'); const stream = c.req.raw.body; if (!stream) throw new QualifiedFundedError(400);
  const reader = stream.getReader(); const bytes = new Uint8Array(4096); let size = 0; let count = 0; let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new QualifiedFundedError()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  try {
    for (;;) { const part = await Promise.race([reader.read(), stopped]); if (part.done) break;
      if (++count > 64 || size + part.value.length > 4096) throw new QualifiedFundedError(400); bytes.set(part.value, size); size += part.value.length; }
    signal.throwIfAborted(); if (size !== Number(c.req.header('content-length'))) throw new QualifiedFundedError(400);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) {
    void reader.cancel().catch(cleanup => console.warn('[qualified-funded] Body cleanup:', cleanup instanceof Error ? cleanup.name : 'UnknownError'));
    if (error instanceof SyntaxError || error instanceof TypeError) throw new QualifiedFundedError(400); throw error;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
function routes(service: QualifiedFundedService, controlToken?: string) {
  if (!service || (controlToken !== undefined && !/^[\x21-\x7e]{32,4096}$/.test(controlToken))) throw new QualifiedFundedError();
  const app = new Hono<RouteEnv>();
  app.onError((error, c) => fail(c, error instanceof QualifiedFundedError ? error.status : 503));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store, private');
    try { return await service.requestScope(c.req.raw.signal, async signal => {
      c.set('qualifiedSignal', signal);
      if (controlToken !== undefined) {
        const header = c.req.header('authorization');
        if (!header || header.length > 4103 || !timingSafeTokenEquals(header.startsWith('Bearer ') ? header.slice(7) : undefined, controlToken)) return fail(c, 401);
        if (new URL(c.req.url).search) return fail(c, 400);
      } else await service.authenticate(runtimeAuth(c), signal);
      if (!headers(c)) return fail(c, 400); if (Number(c.req.header('content-length')) > 4096) return fail(c, 413);
      await next();
    }); } catch (error) { return fail(c, error instanceof QualifiedFundedError ? error.status : 503); }
  });
  return app;
}
const limit = () => bodyLimit({ maxSize: 4096, onError: c => fail(c, 413) });
/** Mount only by explicit service dependency under /internal/containers/:handle/ai/qualified. */
export function createQualifiedFundedRuntimeRoutes(options: { service: QualifiedFundedService }) {
  const app = routes(options.service);
  app.post('/managed-route', limit(), async c => {
    const input = GoogleQualifiedFundedDiscoveryRequestSchema.safeParse(await json(c)); if (!input.success) return fail(c, 400);
    return c.json(await options.service.discover(runtimeAuth(c), input.data, c.get('qualifiedSignal')), 200);
  });
  app.post('/funded-credential', limit(), async c => {
    const input = GoogleQualifiedFundedIssueRequestSchema.safeParse(await json(c)); if (!input.success) return fail(c, 400);
    return c.json(await options.service.issue(runtimeAuth(c), input.data, c.get('qualifiedSignal')), 200);
  });
  return app;
}
/** Mount only by explicit service dependency under /internal/ai/funded/qualified. */
export function createQualifiedFundedRelayRoutes(options: { service: QualifiedFundedService; controlToken: string }) {
  const app = routes(options.service, options.controlToken);
  app.post('/check', limit(), async c => {
    const input = GoogleQualifiedFundedCheckRequestSchema.safeParse(await json(c)); if (!input.success) return fail(c, 400);
    return c.json(await options.service.check(input.data, c.get('qualifiedSignal')), 200);
  });
  app.post('/authorize', limit(), async c => {
    const input = GoogleQualifiedFundedAuthorizationRequestSchema.safeParse(await json(c)); if (!input.success) return fail(c, 400);
    return c.json(await options.service.authorize(input.data, c.get('qualifiedSignal')), 200);
  });
  app.post('/dispatch-check', limit(), async c => {
    const input = GoogleQualifiedFundedDispatchCheckRequestSchema.safeParse(await json(c)); if (!input.success) return fail(c, 400);
    return c.json(await options.service.dispatchCheck(input.data, c.get('qualifiedSignal')), 200);
  });
  return app;
}
