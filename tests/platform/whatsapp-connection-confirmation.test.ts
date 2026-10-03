import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createWhatsAppRepository, WHATSAPP_AGENT_CONSENT_VERSION } from '../../packages/platform/src/whatsapp/repository.js';
import { createWhatsAppService } from '../../packages/platform/src/whatsapp/service.js';
import { readWhatsAppConfig } from '../../packages/platform/src/whatsapp/config.js';
import { decryptWhatsAppPayload, encryptWhatsAppPayload, hashWhatsAppSecret } from '../../packages/platform/src/whatsapp/crypto.js';

const owner = 'user_owner';
const phone = '46701234567';
const sender = 'SE.provenAccount';
const key = 'a'.repeat(64);
const config = readWhatsAppConfig({ WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_VERIFY_TOKEN: 'verify-token',
  WHATSAPP_ACCESS_TOKEN: 'private-token', WHATSAPP_PHONE_NUMBER_ID: '123456', WHATSAPP_GRAPH_API_VERSION: 'v25.0',
  WHATSAPP_ENCRYPTION_KEY: key, WHATSAPP_PUBLIC_URL: 'https://app.example.com', WHATSAPP_ALLOWED_SENDERS: phone })!;
let db: Awaited<ReturnType<typeof createTestPlatformDb>>['db'];
let client: Awaited<ReturnType<typeof createTestPlatformDb>>['instance']['client'];
let repo: ReturnType<typeof createWhatsAppRepository>;
let now: number;
let service: ReturnType<typeof createWhatsAppService> | undefined;
beforeEach(async () => {
  const created = await createTestPlatformDb(); db = created.db; client = created.instance.client;
  now = Date.UTC(2026, 9, 3, 12); repo = createWhatsAppRepository(db, key, () => now);
});
afterEach(async () => { await service?.shutdown(); service = undefined; vi.restoreAllMocks(); await destroyTestPlatformDb(db); });
async function proof(deadline = now + 60_000, requestId = 'wamid.link') {
  const { token } = await repo.startLink(sender, requestId, deadline, phone);
  await repo.claim(token, owner);
  const job = (await repo.lease())!;
  const code = String(job.payload.text).match(/\b\d{6}\b/)![0];
  await repo.finish(job.id, job.fence, 'complete');
  return { token, code };
}
const confirm = ({ token, code }: { token: string; code: string }) => repo.confirm(token, owner, code, WHATSAPP_AGENT_CONSENT_VERSION);

describe('WhatsApp connection confirmation', () => {
  it('atomically queues one private confirmation for the proven phone and association', async () => {
    const pending = await proof();
    const linked = await confirm(pending);
    await expect(confirm(pending)).rejects.toMatchObject({ code: 'invalid_link' });
    const job = (await repo.lease())!;
    expect(job).toMatchObject({ sender, expiresAt: now + 60_000, payload: {
      kind: 'reply', owner, connectionId: linked.id, phone,
      text: expect.stringContaining('connected to WhatsApp'),
    } });
    expect(String(job.payload.text)).toContain('STOP');
    const stored = await sql<{ payload: string }>`SELECT payload FROM whatsapp_jobs WHERE id=${job.id}`.execute(db.kysely);
    expect(stored.rows[0]!.payload).not.toContain(phone);
    expect(stored.rows[0]!.payload).not.toContain(owner);
    await repo.finish(job.id, job.fence, 'complete');
    expect(await repo.lease()).toBeNull();
  });
  it('does not queue success for wrong proof or missing consent', async () => {
    const pending = await proof();
    await expect(repo.confirm(pending.token, owner, pending.code)).rejects.toMatchObject({ code: 'invalid_link' });
    await expect(confirm({ ...pending, code: pending.code === '000000' ? '111111' : '000000' })).rejects.toMatchObject({ code: 'invalid_link' });
    expect(await repo.getConnection(owner)).toBeNull();
    expect(await repo.lease()).toBeNull();
  });
  it('queues only one acknowledgement for concurrent confirmation requests', async () => {
    const pending = await proof();
    const outcomes = await Promise.allSettled([confirm(pending), confirm(pending)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const job = (await repo.lease())!;
    expect(job.payload.kind).toBe('reply');
    await repo.finish(job.id, job.fence, 'complete');
    expect(await repo.lease()).toBeNull();
  });
  it('keeps proof retryable when the confirmation queue is saturated', async () => {
    const pending = await proof();
    await sql`INSERT INTO whatsapp_jobs(id,sender,payload,state,available_at,expires_at,created_at)
      SELECT 'wamid.saturated.' || n::text, ${sender}, 'unused-fixture', 'ready', ${now}, ${now + 120_000}, ${now}
      FROM generate_series(1,100) AS n`.execute(db.kysely);
    await expect(confirm(pending)).rejects.toMatchObject({ code: 'capacity' });
    expect(await repo.getConnection(owner)).toBeNull();
    await sql`UPDATE whatsapp_jobs SET state='complete',payload=NULL,finished_at=${now} WHERE state='ready'`.execute(db.kysely);
    await confirm(pending);
    expect((await repo.lease())?.payload.kind).toBe('reply');
  });
  it('rolls back linking and proof consumption when confirmation persistence fails', async () => {
    const pending = await proof();
    const original = client.query.bind(client);
    const failure = new Error('Database unavailable');
    const spy = vi.spyOn(client, 'query').mockImplementation(async (...args: Parameters<typeof client.query>) => {
      if (args[0].startsWith('insert into "whatsapp_jobs"')) throw failure;
      return original(...args);
    });
    await expect(confirm(pending)).rejects.toBe(failure);
    spy.mockRestore();
    expect(await repo.getConnection(owner)).toBeNull();
    expect(await repo.lease()).toBeNull();
    await confirm(pending);
    expect((await repo.lease())?.payload.kind).toBe('reply');
  });
  it('delivers after worker restart exactly once without running the agent', async () => {
    await confirm(await proof());
    const send = vi.fn(async () => 'wamid.confirmed');
    const agent = { start: vi.fn(), poll: vi.fn() };
    // The request process commits; a separately composed worker drains its outbox.
    service = createWhatsAppService({ config, repository: createWhatsAppRepository(db, key, () => now), agent, send, now: () => now });
    await service.tick(); await service.tick();
    expect(send).toHaveBeenCalledExactlyOnceWith(phone, expect.stringContaining('connected to WhatsApp'));
    expect(agent.start).not.toHaveBeenCalled(); expect(agent.poll).not.toHaveBeenCalled();
  });
  it('revokes queued confirmation on disconnect and rejects a stale leased association after relinking', async () => {
    await confirm(await proof());
    const old = (await repo.lease())!;
    await repo.disconnect(owner);
    now += 1000;
    const next = await confirm(await proof(now + 60_000, 'wamid.relink'));
    expect(next.id).not.toBe(old.payload.connectionId);
    const send = vi.fn(async () => 'wamid.confirmed');
    const lease = vi.spyOn(repo, 'lease').mockResolvedValueOnce(old);
    service = createWhatsAppService({ config, repository: repo, agent: { start: vi.fn(), poll: vi.fn() }, send, now: () => now });
    await service.tick(); expect(send).not.toHaveBeenCalled(); lease.mockRestore();
    await service.tick(); expect(send).toHaveBeenCalledOnce();
  });
  it('gives late confirmation ten minutes for delivery within the original reply window', async () => {
    const pending = await proof(now + 86_400_000);
    now += 599_999;
    await confirm(pending);
    now += 1000;
    const acknowledgement = (await repo.lease())!;
    expect(acknowledgement.expiresAt).toBe(now - 1000 + 600_000);
  });
  it('caps late confirmation at the original shorter reply window', async () => {
    const deadline = now + 650_000;
    const pending = await proof(deadline);
    now += 599_999;
    await confirm(pending);
    expect((await repo.lease())!.expiresAt).toBe(deadline);
  });
  it('never extends the original reply window for a confirmation', async () => {
    await confirm(await proof(now + 10_000));
    now += 10_000;
    expect(await repo.lease()).toBeNull();
  });
  it('uses the conservative challenge deadline for proofs issued before reply-window persistence', async () => {
    const pending = await proof(now + 86_400_000);
    const hash = hashWhatsAppSecret(pending.token);
    const challenge = await sql<{ token_cipher: string }>`SELECT token_cipher FROM whatsapp_link_challenges WHERE token_hash=${hash}`.execute(db.kysely);
    const payload = decryptWhatsAppPayload(challenge.rows[0]!.token_cipher, key);
    delete payload.replyDeadline;
    await sql`UPDATE whatsapp_link_challenges SET token_cipher=${encryptWhatsAppPayload(payload, key)} WHERE token_hash=${hash}`.execute(db.kysely);
    now += 599_999;
    await confirm(pending);
    expect((await repo.lease())!.expiresAt).toBe(now + 1);
  });
});
