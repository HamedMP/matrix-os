import { timingSafeEqual, createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod/v4';
import { OperatorProbeAttemptLookupSchema, OperatorProbeBeginSchema, OperatorProbeFinalizeSchema,
  type OperatorProbeBudgetStore } from '@matrix-os/contracts/funded-operator-probe';
import { OperatorProbeBudgetError } from './repository.js';
export const OPERATOR_PROBE_AUTHORITY_BASE = '/ai/operator-probe-budget';
export function createOperatorProbeBudgetApp({ token, store, budgetId }: { token: string; budgetId?: string; store: OperatorProbeBudgetStore }) {
  if (token.length < 32 || token.length > 4096) throw new Error('Strong operator probe authority token required');
  const expected = Buffer.from(`Bearer ${token}`);
  const etag = budgetId ? '"' + createHash('sha256').update(budgetId).digest('hex') + '"' : undefined;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const actual = Buffer.from(c.req.header('Authorization') ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: 'Unauthorized' }, 401);
    if (new URL(c.req.url).search) return c.json({ error: 'Invalid request' }, 400);
    const expectedWallet = c.req.header('If-Match');
    if (expectedWallet !== undefined && expectedWallet !== etag) return c.json({ error: 'Request unavailable' }, 412);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 400);
    if (error instanceof OperatorProbeBudgetError) return c.json({ error: 'Request unavailable' }, error.reason === 'conflict' ? 409 : 503);
    console.error('[operator-probe-budget] Authority request failed', error);
    return c.json({ error: 'Request unavailable' }, 503);
  });
  const limit = () => bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'Request too large' }, 413) });
  // The envelope also makes preconditioned writes invalid to a legacy authority
  // which would otherwise silently ignore If-Match and spend from the wrong wallet.
  const envelope = z.strictObject({ operation: z.unknown() });
  async function mutation(c: Context) {
    const raw: unknown = await c.req.json();
    return c.req.header('If-Match') === undefined ? raw : envelope.parse(raw).operation;
  }
  app.post(`${OPERATOR_PROBE_AUTHORITY_BASE}/begin`, limit(), async c => c.json(await store.begin(OperatorProbeBeginSchema.parse(await mutation(c)))));
  app.post(`${OPERATOR_PROBE_AUTHORITY_BASE}/finalize`, limit(), async c => c.json(await store.finalize(OperatorProbeFinalizeSchema.parse(await mutation(c)))));
  app.post(`${OPERATOR_PROBE_AUTHORITY_BASE}/attempt`, limit(), async c => {
    const { probeId } = OperatorProbeAttemptLookupSchema.parse(await c.req.json());
    return c.json(await store.getAttempt(probeId));
  });
  app.get(`${OPERATOR_PROBE_AUTHORITY_BASE}/status`, async c => c.json(await store.getStatus()));
  return app;
}
