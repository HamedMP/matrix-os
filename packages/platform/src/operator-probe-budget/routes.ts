import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod/v4';
import { OperatorProbeAttemptLookupSchema, OperatorProbeBeginSchema, OperatorProbeFinalizeSchema,
  type OperatorProbeBudgetStore } from '@matrix-os/contracts/funded-operator-probe';
import { OperatorProbeBudgetError } from './repository.js';
export const OPERATOR_PROBE_AUTHORITY_BASE = '/ai/operator-probe-budget';
export function createOperatorProbeBudgetApp({ token, store }: { token: string; store: OperatorProbeBudgetStore }) {
  if (token.length < 32 || token.length > 4096) throw new Error('Strong operator probe authority token required');
  const expected = Buffer.from(`Bearer ${token}`);
  const app = new Hono();
  app.use('*', async (c, next) => {
    const actual = Buffer.from(c.req.header('Authorization') ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: 'Unauthorized' }, 401);
    if (new URL(c.req.url).search) return c.json({ error: 'Invalid request' }, 400);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 400);
    if (error instanceof OperatorProbeBudgetError) return c.json({ error: 'Request unavailable' }, error.reason === 'conflict' ? 409 : 503);
    console.error('[operator-probe-budget] Authority request failed', error);
    return c.json({ error: 'Request unavailable' }, 503);
  });
  const limit = () => bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'Request too large' }, 413) });
  app.post(`${OPERATOR_PROBE_AUTHORITY_BASE}/begin`, limit(), async c => c.json(await store.begin(OperatorProbeBeginSchema.parse(await c.req.json()))));
  app.post(`${OPERATOR_PROBE_AUTHORITY_BASE}/finalize`, limit(), async c => c.json(await store.finalize(OperatorProbeFinalizeSchema.parse(await c.req.json()))));
  app.post(`${OPERATOR_PROBE_AUTHORITY_BASE}/attempt`, limit(), async c => {
    const { probeId } = OperatorProbeAttemptLookupSchema.parse(await c.req.json());
    return c.json(await store.getAttempt(probeId));
  });
  app.get(`${OPERATOR_PROBE_AUTHORITY_BASE}/status`, async c => c.json(await store.getStatus()));
  return app;
}
