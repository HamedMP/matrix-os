import { serve } from '@hono/node-server';
import { configureEdgeRequestDeadlines } from '@matrix-os/contracts/http-request-deadlines';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Agent } from 'undici';
import type { ClerkAuth } from './clerk-auth.js';
import { createPlatformDb } from './db.js';
import { ClerkOrganizationUpstreamClient } from './organizations/clerk-resolver.js';
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from './organizations/database.js';
import { createOrganizationMembershipProjection } from './organizations/projection.js';
import { PlatformOrganizationRepository } from './organizations/repository.js';
import { bootstrapPlatformSlack } from './slack-startup.js';

export function createSlackDevCallbackApp(origin: string, slackRoutes: Hono): Hono {
  const host = new URL(origin).host;
  const app = new Hono();
  app.get('/health', c => c.json({ status: 'ok' }));
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const slackPath = /^\/(?:api|webhooks|internal)\/slack(?:\/|$)/.test(path) || path === '/slack/link';
    // Cloud Run terminates HTTPS before forwarding the request to Node.
    if (!slackPath || new URL(c.req.url).host !== host) return c.notFound();
    await next();
  });
  app.route('/', slackRoutes);
  return app;
}

export async function startSlackDevCallbackServer(options: {
  env: NodeJS.ProcessEnv;
  origin: string;
  port: number;
  databaseUrl: string;
  clerkAuth?: ClerkAuth;
  platformSecret: string;
  customerVpsProxyDispatcher: Agent;
  containerProxyDispatcher: Agent;
  registerStartupCleanup(cleanup: () => Promise<void>): void;
}): Promise<void> {
  const cleanups: Array<() => Promise<unknown>> = [
    () => options.containerProxyDispatcher.close(),
    () => options.customerVpsProxyDispatcher.close(),
  ];
  let closing: Promise<void> | undefined;
  const cleanup = () => closing ??= (async () => {
    let failed = false;
    for (const close of cleanups.reverse()) {
      try {
        await close();
      } catch (error: unknown) {
        failed = true;
        console.error('[slack-dev-callback] Cleanup failed', error instanceof Error ? error.name : 'UnknownError');
      }
    }
    if (failed) throw new Error('Slack Dev callback cleanup failed');
  })();
  options.registerStartupCleanup(cleanup);

  const db = createPlatformDb(options.databaseUrl);
  cleanups.push(() => db.destroy());
  await db.ready;
  const clerkSecretKey = options.env.CLERK_SECRET_KEY;
  let devOrganizations: Parameters<typeof bootstrapPlatformSlack>[0]['devOrganizations'];
  if (options.clerkAuth && clerkSecretKey) {
    const organizationDb = db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformOrganizationDatabase(organizationDb);
    const repository = new PlatformOrganizationRepository(organizationDb);
    const projection = createOrganizationMembershipProjection({
      repository,
      upstream: new ClerkOrganizationUpstreamClient({ secretKey: clerkSecretKey }),
      startTimers: false,
    });
    cleanups.push(() => projection.shutdown());
    devOrganizations = { repository, projection };
  }
  const slack = await bootstrapPlatformSlack({
    env: options.env,
    db,
    clerkAuth: options.clerkAuth,
    platformSecret: options.platformSecret,
    platformJwtSecret: '',
    devOrganizations,
    startCleanup: false,
  });
  cleanups.push(() => slack.close());

  const app = createSlackDevCallbackApp(options.origin, slack.routes);
  const server = serve({
    fetch: app.fetch,
    hostname: options.env.MATRIX_BIND_HOST,
    port: options.port,
  }, () => {
    console.log(`[slack-dev-callback] Listening on :${options.port}`);
  });
  configureEdgeRequestDeadlines(server);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    server.close(error => {
      void cleanup().then(() => process.exit(error ? 1 : 0), () => process.exit(1));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
