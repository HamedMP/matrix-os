import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';
import { createWhatsAppRepository } from '../../packages/platform/src/whatsapp/repository.js';
import { encryptWhatsAppPayload } from '../../packages/platform/src/whatsapp/crypto.js';

const key = Buffer.alloc(32, 7);
const now = Date.UTC(2026, 9, 5);
const owner = 'user_owner';
const neighbor = 'user_neighbor';
const sender = '46701234567';
const otherSender = '46707654321';
let db: Awaited<ReturnType<typeof createTestPlatformDb>>['db'];
let repository: ReturnType<typeof createWhatsAppRepository>;

beforeEach(async () => {
  ({ db } = await createTestPlatformDb());
  repository = createWhatsAppRepository(db, key, () => now);
});
afterEach(async () => { await destroyTestPlatformDb(db); });

async function connect(account: string, phone: string) {
  await sql`INSERT INTO whatsapp_connections(id,owner,sender,consent_version,created_at)
    VALUES(${`connection:${account}`},${account},${phone},'whatsapp-general-agent-v1',${now})`.execute(db.executor);
}
async function cleanup() {
  const adapters = createAccountDeletionAdapters({ db, clerkSecretKey: 'test-key', r2PrefixRoot: 'matrixos-sync' });
  await adapters.integrations({ clerkUserId: owner, appleTokens: [] });
}
async function jobIds() {
  return (await sql<{ id: string }>`SELECT id FROM whatsapp_jobs ORDER BY id`.execute(db.executor)).rows.map((row) => row.id);
}

describe('account deletion encrypted WhatsApp cleanup', () => {
  it('erases encrypted incoming, run, reply and terminal jobs for the current connection without decoding neighbor ciphertext', async () => {
    await connect(owner, sender);
    await connect(neighbor, otherSender);
    for (const kind of ['incoming', 'run', 'reply']) {
      await repository.enqueue({ id: `owned:${kind}`, sender, expiresAt: now + 60_000,
        payload: { kind, owner, connectionId: `connection:${owner}`, text: 'private data' } });
    }
    await sql`INSERT INTO whatsapp_jobs(id,sender,payload,state,available_at,expires_at,created_at)
      VALUES('owned:terminal',${sender},NULL,'complete',${now},${now + 60_000},${now}),
        ('neighbor:corrupt',${otherSender},'unreadable encrypted data','ready',${now},${now + 60_000},${now})`.execute(db.executor);
    const encrypted = await sql<{ payload: string }>`SELECT payload FROM whatsapp_jobs WHERE id='owned:incoming'`.execute(db.executor);
    expect(encrypted.rows[0]?.payload).toMatch(/^v1\./);
    await cleanup();
    expect(await jobIds()).toEqual(['neighbor:corrupt']);
    expect(await repository.enqueue({ id: 'owned:stale', sender, expiresAt: now + 60_000,
      payload: { kind: 'incoming', owner, connectionId: `connection:${owner}`, text: 'stale snapshot' } })).toBe(false);
    expect(await jobIds()).toEqual(['neighbor:corrupt']);
    expect(await repository.getConnection(owner)).toBeNull();
    expect(await repository.getConnection(neighbor)).toMatchObject({ sender: otherSender });
    await cleanup();
    expect(await jobIds()).toEqual(['neighbor:corrupt']);
  });

  it('erases encrypted verification jobs for an unconfirmed owner link and preserves another pending link', async () => {
    const first = await repository.startLink(sender, 'link:owner');
    const second = await repository.startLink(otherSender, 'link:neighbor');
    await repository.claim(first.token, owner);
    await repository.claim(second.token, neighbor);
    const neighborJob = await sql<{ id: string }>`SELECT 'verification:' || token_hash AS id
      FROM whatsapp_link_challenges WHERE owner=${neighbor}`.execute(db.executor);
    await cleanup();
    expect(await jobIds()).toEqual([neighborJob.rows[0]!.id]);
    const challenges = await sql<{ owner: string }>`SELECT owner FROM whatsapp_link_challenges`.execute(db.executor);
    expect(challenges.rows).toEqual([{ owner: neighbor }]);
  });

  it('deletes exact jobs from the old owner challenge without deleting jobs after the sender was reassigned', async () => {
    await connect(neighbor, sender);
    const hash = 'a'.repeat(64);
    await sql`INSERT INTO whatsapp_link_challenges(token_hash,request_id,sender,token_cipher,owner,state,created_at,expires_at)
      VALUES(${hash},'link:former',${sender},'',${owner},'consumed',${now - 60_000},${now})`.execute(db.executor);
    for (const prefix of ['verification', 'connected']) {
      await sql`INSERT INTO whatsapp_jobs(id,sender,payload,state,available_at,expires_at,created_at)
        VALUES(${`${prefix}:${hash}`},${sender},${encryptWhatsAppPayload({ kind: 'reply', owner, text: 'old owner data' }, key)},
          'ready',${now},${now + 60_000},${now})`.execute(db.executor);
    }
    await repository.enqueue({ id: 'neighbor:incoming', sender, expiresAt: now + 60_000,
      payload: { kind: 'incoming', owner: neighbor, connectionId: `connection:${neighbor}`, text: 'neighbor data' } });
    await cleanup();
    expect(await jobIds()).toEqual(['neighbor:incoming']);
    expect(await repository.getConnection(neighbor)).toMatchObject({ sender });
  });
});
