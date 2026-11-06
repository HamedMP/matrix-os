import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { z } from 'zod/v4';
import { createOperatorProbeBudgetDatabase } from './database.js';
import { runOperatorProbeBudgetMigrations } from './migration.js';
import { createOperatorProbeBudgetRepository } from './repository.js';
import { createOperatorProbeBudgetApp } from './routes.js';
/** Dedicated inputs only: never fall back to application/customer database credentials. */
export function readOperatorProbeAuthorityConfig(env: NodeJS.ProcessEnv) {
  return z.strictObject({
    databaseUrl: z.url().refine(url => ['postgres:', 'postgresql:'].includes(new URL(url).protocol)),
    token: z.string().min(32).max(4096), budgetId: z.string().min(1).max(160),
    hostname: z.enum(['127.0.0.1', '::1']), port: z.coerce.number().int().min(1024).max(65535),
  }).parse({ databaseUrl: env.MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_DATABASE_URL,
    token: env.MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_TOKEN,
    budgetId: env.MATRIX_FUNDED_AI_OPERATOR_PROBE_BUDGET_ID,
    hostname: env.MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_HOST ?? '127.0.0.1',
    port: env.MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_PORT ?? '19947' });
}
export async function startOperatorProbeAuthority(env: NodeJS.ProcessEnv = process.env) {
  const config = readOperatorProbeAuthorityConfig(env);
  const db = createOperatorProbeBudgetDatabase(config.databaseUrl);
  try {
    await runOperatorProbeBudgetMigrations(db);
    const app = createOperatorProbeBudgetApp({ token: config.token, budgetId: config.budgetId,
      store: createOperatorProbeBudgetRepository({ db, budgetId: config.budgetId }) });
    const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const listener = serve({ fetch: app.fetch, hostname: config.hostname, port: config.port }, () => resolve(listener));
      listener.once('error', reject);
    });
    if ('requestTimeout' in server) { server.requestTimeout = 10_000; server.headersTimeout = 5_000; server.timeout = 15_000; }
    let closing: Promise<void> | undefined;
    function close() {
      return closing ??= new Promise<void>((resolve, reject) => {
        // Stop admission and drain HTTP handlers before closing the pool they use.
        server.close(error => { db.destroy().then(() => error ? reject(error) : resolve(), reject); });
        if ('closeIdleConnections' in server) server.closeIdleConnections();
      });
    }
    return { server, close };
  } catch (error: unknown) { await db.destroy(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startOperatorProbeAuthority().then(service => {
    const shutdown = () => { service.close().catch(error => { console.error('[operator-probe-budget] Shutdown failed', error); process.exitCode = 1; }); };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  }).catch(error => { console.error('[operator-probe-budget] Startup failed', error); process.exitCode = 1; });
}
