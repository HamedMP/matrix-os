import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformDb } from '../../packages/platform/src/db.js';
import { createAccountDeletionMutationGuard } from '../../packages/platform/src/account-deletion/integration-admission.js';
import { createWhatsAppRepository, WHATSAPP_AGENT_CONSENT_VERSION } from '../../packages/platform/src/whatsapp/repository.js';
import { createWhatsAppRoutes } from '../../packages/platform/src/whatsapp/routes.js';
import { readWhatsAppConfig } from '../../packages/platform/src/whatsapp/config.js';
import { encryptWhatsAppPayload, hashWhatsAppCode, hashWhatsAppSecret } from '../../packages/platform/src/whatsapp/crypto.js';
import type { WhatsAppService } from '../../packages/platform/src/whatsapp/service.js';

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const env = { ACCOUNT_DELETION_SECRET: 'whatsapp-scope-regression-secret-at-least-32' };
const key = Buffer.alloc(32, 7);

async function fixture() {
  const schema = `whatsapp_scope_${randomUUID().replaceAll('-', '')}`;
  const admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 1500,
    options: `-c search_path=${schema},public -c statement_timeout=3000` });
  const db = createPlatformDb({ dialect: new PostgresDialect({ pool }) });
  await db.ready;
  return { db, pool, async close() {
    await db.destroy(); await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy();
  } };
}

describe.skipIf(!connectionString)('WhatsApp request transaction boundaries on PostgreSQL', () => {
  it('does not queue admitted connections behind a background operation waiting for the pool', async () => {
    const { db, pool, close } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending: Promise<unknown>[] = [];
    try {
      const repo = createWhatsAppRepository(db, key);
      const app = new Hono();
      let entered = 0;
      app.use('*', createAccountDeletionMutationGuard({ db, env, resolveOwner: c => c.req.header('x-test-owner') }));
      app.post('/disconnect', async c => {
        entered++;
        await gate;
        await repo.disconnect(c.req.header('x-test-owner')!);
        return c.json({ disconnected: true });
      });
      const requests = ['user_queue_a', 'user_queue_b'].map(owner =>
        app.request('/disconnect', { method: 'POST', headers: { 'x-test-owner': owner } }));
      pending.push(...requests);
      await vi.waitFor(() => { expect(entered).toBe(2); expect(pool.idleCount).toBe(0); }, { timeout: 1000 });
      // The worker has no admitted request connection. Put it ahead of request
      // repository calls while both pool connections belong to the guard.
      const worker = repo.lease();
      const workerOutcome = worker.then(value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }));
      pending.push(workerOutcome);
      await vi.waitFor(() => expect(pool.waitingCount).toBe(1), { timeout: 1000 });
      release();

      const responses = await Promise.all(requests);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect(await workerOutcome).toEqual({ status: 'fulfilled', value: null });
    } finally {
      release(); await Promise.allSettled(pending); await close();
    }
  }, 30_000);

  it('rolls back failed confirmation writes while retaining intentional wrong-code attempt counts', async () => {
    const { db, close } = await fixture();
    try {
      const now = Date.now();
      const owner = 'user_proof';
      const sender = '46701234567';
      const repo = createWhatsAppRepository(db, key, () => now);
      const { token } = await repo.startLink(sender, 'wamid.scope-proof', now + 60_000);
      await repo.claim(token, owner);
      const hash = hashWhatsAppSecret(token);
      // This validly encrypted proof fails the repository's explicit deadline
      // validation after it has attempted to insert the connection.
      await sql`UPDATE whatsapp_link_challenges SET code_hash=${hashWhatsAppCode('123456', key)},
        token_cipher=${encryptWhatsAppPayload({ token, replyDeadline: now + 59_000 }, key)}
        WHERE token_hash=${hash}`.execute(db.executor);
      const origin = 'https://app.example.com';
      const config = readWhatsAppConfig({ WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_VERIFY_TOKEN: 'verify-secret',
        WHATSAPP_ACCESS_TOKEN: 'private-token', WHATSAPP_PHONE_NUMBER_ID: '123456', WHATSAPP_GRAPH_API_VERSION: 'v25.0',
        WHATSAPP_ENCRYPTION_KEY: key.toString('hex'), WHATSAPP_PUBLIC_URL: origin, WHATSAPP_ALLOWED_SENDERS: sender })!;
      const app = createWhatsAppRoutes({ config, repository: repo,
        service: { ingest: async () => {} } as unknown as WhatsAppService,
        authenticate: async () => owner, publishableKey: 'pk_test_scope',
        admissionMiddleware: createAccountDeletionMutationGuard({ db, env, resolveOwner: c => c.get('whatsappOwner') as string }),
      });
      const confirm = (code: string) => app.request('/api/whatsapp/confirm', { method: 'POST',
        headers: { authorization: 'Bearer owner-token', origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token, code, consentVersion: WHATSAPP_AGENT_CONSENT_VERSION }) });

      expect((await confirm('000000')).status).toBe(403);
      expect((await sql<{ attempts: number }>`SELECT attempts FROM whatsapp_link_challenges WHERE token_hash=${hash}`
        .execute(db.executor)).rows[0]!.attempts).toBe(1);
      expect((await confirm('123456')).status).toBe(403);
      expect(await repo.getConnection(owner)).toBeNull();
      expect((await sql<{ attempts: number; state: string }>`SELECT attempts,state FROM whatsapp_link_challenges WHERE token_hash=${hash}`
        .execute(db.executor)).rows[0]).toEqual({ attempts: 1, state: 'claimed' });
    } finally { await close(); }
  }, 30_000);
});
