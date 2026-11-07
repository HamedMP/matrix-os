import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { hasVerifiedClerkBrowserSession, type ClerkAuth } from '../clerk-auth.js';
import { DevstackInstanceSchema } from '../devstack-identity.js';
import type { RegisteredRuntimeEndpoint } from '../devstack-registered-runtime.js';
import type { DevstackRunConfig, DevstackRunTarget } from './config.js';
import { emptyDevstackResult, type DevstackRunResult } from './execute.js';
import type { DevstackRunRecord, DevstackRunStore } from './store.js';

const uuid = z.uuidv4().refine(value => value === value.toLowerCase());
const selection = DevstackInstanceSchema.refine(value => !value.includes('\n'));
const dispatchSchema = z.strictObject({
  runId: uuid,
  runtime: selection,
  worktree: selection,
  kind: z.enum(['exec', 'test']),
  command: z.array(z.string().min(1).max(4096).refine(value => !value.includes('\0')))
    .min(1).max(57).refine(args => !args[0]?.startsWith('-') && Buffer.byteLength(JSON.stringify(args)) <= 12 * 1024),
});
const cursorSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,2})$/).transform(Number).pipe(z.number().max(512));
const pageSize = 8;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function resultPage(record: DevstackRunRecord, cursor = 0) {
  const logs = record.logs.slice(cursor, cursor + pageSize);
  const nextCursor = cursor + logs.length;
  const testStatus = record.status === 'succeeded' ? 'passed'
    : record.status === 'failed' || record.status === 'timed_out' ? record.status : null;
  return {
    runId: record.runId,
    status: record.status,
    runtime: record.runtime,
    worktree: record.worktree,
    revision: record.revision,
    previewUrl: record.previewUrl,
    exitCode: record.exitCode,
    testResult: record.kind === 'test' && testStatus ? { status: testStatus, exitCode: record.exitCode } : null,
    logs,
    nextCursor,
    hasMore: nextCursor < record.logs.length,
    truncated: record.truncated,
  };
}

interface DevstackRunRoutesDeps {
  config: DevstackRunConfig;
  clerkAuth: ClerkAuth;
  store: DevstackRunStore;
  resolve(target: DevstackRunTarget): Promise<RegisteredRuntimeEndpoint | null>;
  execute(endpoint: RegisteredRuntimeEndpoint, target: DevstackRunTarget, command: string[]): Promise<DevstackRunResult>;
}

function matchesTarget(endpoint: RegisteredRuntimeEndpoint | null, target: DevstackRunTarget): endpoint is RegisteredRuntimeEndpoint {
  return endpoint?.containerId === target.containerId && endpoint.handle === target.handle && endpoint.clerkUserId === target.owner;
}

export function createDevstackRunRoutes(deps: DevstackRunRoutesDeps) {
  const { config, clerkAuth, store } = deps;
  const app = new Hono<{ Variables: { owner: string; keyDigest: string } }>();
  const unavailable = (c: Context) => c.json({ error: 'DevStack run unavailable' }, 404);
  const invalid = (c: Context) => c.json({ error: 'Invalid DevStack run request' }, 400);
  const changed = (c: Context) => c.json({ error: 'DevStack run conflicts with a prior run or runtime binding' }, 409);

  app.onError((error, c) => {
    console.error('[platform] DevStack run request failed', error.name);
    return c.json({ error: 'DevStack run service unavailable' }, 503);
  });
  app.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    const bearer = c.req.header('authorization');
    if (!bearer?.startsWith('Bearer ') || bearer.length > 8192) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    const claims = await clerkAuth.verify(bearer.slice(7));
    if (!claims.authenticated) return c.json({ error: 'Authentication required' }, 401);
    const owner = claims.userId;
    if (!owner || !config.operators.includes(owner) || claims.issuer !== config.issuer || !claims.devstackOperator
      || !hasVerifiedClerkBrowserSession(claims, owner) || !/^sess_[A-Za-z0-9_]{1,128}$/.test(claims.sessionId)) {
      return c.json({ error: 'DevStack operator access required' }, 403);
    }
    const key = c.req.header('x-devstack-run-key');
    if (!key || !/^[0-9a-f]{64}$/.test(key) || key.length !== 64) return unavailable(c);
    c.set('owner', owner);
    c.set('keyDigest', digest(key));
    await next();
  });

  async function executeDetached(
    runId: string, bound: RegisteredRuntimeEndpoint, target: DevstackRunTarget, command: string[],
  ): Promise<void> {
    let result: DevstackRunResult;
    try {
      const endpoint = await deps.resolve(target);
      result = matchesTarget(endpoint, target) && endpoint.host === bound.host && endpoint.port === bound.port
        ? await deps.execute(endpoint, target, command)
        : emptyDevstackResult('binding_rejected');
    } catch (error: unknown) {
      console.error('[platform] DevStack run transport failed', error instanceof Error ? error.name : typeof error);
      result = emptyDevstackResult('interrupted');
    }
    await store.finish(runId, result);
  }

  app.post('/', bodyLimit({ maxSize: 16 * 1024 }), async c => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return invalid(c);
    }
    const parsed = dispatchSchema.safeParse(json);
    if (!parsed.success) return invalid(c);
    const input = parsed.data;
    const owner = c.get('owner');
    const keyDigest = c.get('keyDigest');
    const requestDigest = digest(JSON.stringify(input));
    const prior = await store.read(input.runId, owner, keyDigest);
    if (prior) return prior.requestDigest === requestDigest ? c.json(resultPage(prior), 202) : changed(c);

    const target = config.targets.find(candidate =>
      candidate.owner === owner && candidate.runtime === input.runtime && candidate.worktree === input.worktree);
    if (!target) return unavailable(c);
    const bound = await deps.resolve(target);
    if (!matchesTarget(bound, target)) return changed(c);
    const admission = await store.admit({
      runId: input.runId, owner, keyDigest, requestDigest,
      runtime: target.runtime, worktree: target.worktree, containerId: target.containerId,
      cwd: target.cwd, revision: target.revision, kind: input.kind,
      previewUrl: config.previewOrigin + '/vm/' + target.handle + '/',
    });
    if (admission.outcome === 'admitted') {
      // No request signal is forwarded. After commit a disconnected client
      // recovers this run through its original ID and key.
      void executeDetached(input.runId, bound, target, input.command).catch((error: unknown) => {
        console.error('[platform] DevStack run completion write failed', error instanceof Error ? error.name : typeof error);
      });
      return c.json(resultPage(admission.record), 202);
    }
    if (admission.outcome === 'replay') return c.json(resultPage(admission.record), 202);
    if (admission.outcome === 'missing') return unavailable(c);
    if (admission.outcome === 'capacity') return c.json({ error: 'DevStack run retention capacity reached' }, 429);
    return changed(c);
  });

  app.get('/:runId', async c => {
    const runId = uuid.safeParse(c.req.param('runId'));
    const query = new URL(c.req.url).searchParams;
    const cursor = cursorSchema.safeParse(query.get('cursor') ?? '0');
    if (!runId.success || !cursor.success || query.size > 1 || (query.size === 1 && !query.has('cursor'))) return invalid(c);
    const record = await store.read(runId.data, c.get('owner'), c.get('keyDigest'));
    if (!record) return unavailable(c);
    if (cursor.data > record.logs.length) return invalid(c);
    return c.json(resultPage(record, cursor.data));
  });
  return app;
}
