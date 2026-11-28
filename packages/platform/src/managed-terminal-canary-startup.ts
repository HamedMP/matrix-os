import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { configureEdgeRequestDeadlines } from '@matrix-os/contracts/http-request-deadlines';
import { createConfiguredClerkAuth } from './clerk-auth.js';
import { createPlatformDb } from './db.js';
import { managedTerminalCanaryFromEnv } from './managed-terminal-canary.js';
import { createDisabledOrchestrator } from './orchestrator.js';
import type { StartPlatformServerOptions } from './platform-startup.js';
import { refuseAllWebSocketUpgrades } from './platform-worker-mode.js';
import { loadPlatformRuntimeConfig } from './runtime-mode.js';
import { shutdownPlatformApp } from './shutdown-platform-app.js';
import { closeUpstreamDispatchers } from './substrates/upstream-transport.js';

/** A tagged broker revision shares the deployed database but starts no other Platform services. */
export async function startManagedTerminalCanary(
  opts: Pick<StartPlatformServerOptions, 'port' | 'createApp' | 'containerProxyDispatcher' | 'customerVpsProxyDispatcher'>,
  registerCleanup: (cleanup: () => Promise<void>) => void,
): Promise<void> {
  const env = process.env;
  if (env.MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED !== '1' || !managedTerminalCanaryFromEnv(env, Date.now())) {
    throw new Error('Managed Terminal candidate is disabled, invalid, or expired');
  }
  const { platformDatabaseUrl } = loadPlatformRuntimeConfig(env);
  const db = createPlatformDb(platformDatabaseUrl, 'managed-terminal-grants');
  const closeDb = () => db.destroy();
  registerCleanup(closeDb);
  await db.ready;
  const clerkAuth = await createConfiguredClerkAuth(env);
  const app = opts.createApp({
    db, orchestrator: createDisabledOrchestrator({ db }), clerkAuth, env,
  });
  registerCleanup(() => shutdownPlatformApp(app));
  const server = serve({ fetch: app.fetch, hostname: env.MATRIX_BIND_HOST, port: opts.port }, () => {
    console.log(`Platform listening on :${opts.port} (terminal candidate)`);
  }) as Server;
  configureEdgeRequestDeadlines(server);
  refuseAllWebSocketUpgrades(server);

  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    server.close(error => {
      const close = async () => {
        const results = await Promise.allSettled([
          shutdownPlatformApp(app), closeUpstreamDispatchers(),
          opts.containerProxyDispatcher.close(), opts.customerVpsProxyDispatcher.close(),
        ]);
        await closeDb();
        if (error || results.some(result => result.status === 'rejected')) {
          throw new Error('Terminal candidate shutdown incomplete');
        }
      };
      void close().catch((closeError: unknown) => {
        console.error('[terminal-canary] shutdown failed', closeError instanceof Error ? closeError.name : typeof closeError);
        process.exitCode = 1;
      }).finally(() => {
        clearTimeout(deadline);
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
      });
    });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
