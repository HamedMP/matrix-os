import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createWhatsAppRepository } from '../../packages/platform/src/whatsapp/repository.js';
import { decryptWhatsAppPayload, encryptWhatsAppPayload, hashWhatsAppCode } from '../../packages/platform/src/whatsapp/crypto.js';

const key = Buffer.alloc(32, 7);
const sender = '46701234567';
const owner = 'user_owner';
let db: Awaited<ReturnType<typeof createTestPlatformDb>>['db'];
let client: Awaited<ReturnType<typeof createTestPlatformDb>>['instance']['client'];
let now: number;
let repo: ReturnType<typeof createWhatsAppRepository>;
beforeEach(async () => {
  const created = await createTestPlatformDb();
  db = created.db;
  client = created.instance.client;
  now = Date.UTC(2026, 9, 2, 12);
  repo = createWhatsAppRepository(db, key, () => now);
});
afterEach(async () => { vi.restoreAllMocks(); await destroyTestPlatformDb(db); });
async function codeFor(token: string): Promise<string> {
  await repo.claim(token, owner);
  const job = await repo.lease();
  expect(job?.payload.kind).toBe('verification');
  const code = String(job?.payload.text).match(/\b\d{6}\b/)?.[0];
  await repo.finish(job!.id, job!.fence, 'complete');
  return code!;
}
async function finishConnectionConfirmation(): Promise<void> {
  const acknowledgement = (await repo.lease())!;
  expect(acknowledgement?.payload).toMatchObject({ kind: 'reply', owner, text: expect.stringContaining('connected to WhatsApp') });
  await repo.finish(acknowledgement.id, acknowledgement.fence, 'complete');
}

describe('WhatsApp linking repository', () => {
  it('requires sender proof, makes repeated claims idempotent, and consumes tokens', async () => {
    const first = await repo.startLink(sender, 'wamid.first');
    expect(await repo.startLink(sender, 'wamid.first')).toEqual(first);
    expect(await repo.claim(first.token, owner)).toEqual({ maskedSender: '••••4567' });
    expect(await repo.claim(first.token, owner)).toEqual({ maskedSender: '••••4567' });
    const job = await repo.lease();
    const code = String(job!.payload.text).match(/\b\d{6}\b/)![0];
    const storedProof = await sql<{code_hash: string}>`SELECT code_hash FROM whatsapp_link_challenges WHERE request_id='wamid.first'`.execute(db.kysely);
    expect(storedProof.rows[0]!.code_hash).not.toBe(createHash('sha256').update(code).digest('hex'));
    await expect(repo.confirm(first.token, 'other', code, 'whatsapp-general-agent-v1')).rejects.toThrow();
    await expect(repo.confirm(first.token, owner, code === '000000' ? '111111' : '000000', 'whatsapp-general-agent-v1')).rejects.toThrow();
    await expect(repo.confirm(first.token, owner, code)).rejects.toThrow();
    expect(await repo.confirm(first.token, owner, code, 'whatsapp-general-agent-v1')).toMatchObject({ owner, sender });
    await expect(repo.confirm(first.token, owner, code, 'whatsapp-general-agent-v1')).rejects.toThrow();
    expect(await repo.getConnection(owner)).toMatchObject({ sender, chatId: null, machineId: null });
    await finishConnectionConfirmation();
    expect(await repo.lease()).toBeNull();
  });
  it('expires challenges and locks after five invalid attempts without reset on claim', async () => {
    const { token } = await repo.startLink(sender, 'wamid.first');
    const code = await codeFor(token);
    for (let i = 0; i < 5; i++) {
      await expect(repo.confirm(token, owner, code === '000000' ? '111111' : '000000', 'whatsapp-general-agent-v1')).rejects.toThrow();
      if (i < 4) await repo.claim(token, owner);
    }
    await expect(repo.confirm(token, owner, code, 'whatsapp-general-agent-v1')).rejects.toThrow();
    const second = await repo.startLink(sender, 'wamid.second');
    now += 16 * 60_000;
    await expect(repo.claim(second.token, owner)).rejects.toThrow();
  });
  it('bounds linking and verification by the original WhatsApp reply deadline without extending retries', async () => {
    const deadline = now + 60_000;
    const first = await repo.startLink(sender, 'wamid.deadline', deadline);
    now += 20_000;
    expect(await repo.startLink(sender, 'wamid.deadline', now + 600_000)).toEqual(first);
    await repo.claim(first.token, owner);
    const verification = await repo.lease();
    expect(verification?.expiresAt).toBe(deadline);
    const persisted = await sql<{ expires_at: number }>`SELECT expires_at FROM whatsapp_link_challenges WHERE request_id='wamid.deadline'`.execute(db.kysely);
    expect(persisted.rows[0]?.expires_at).toBe(deadline);
    now = deadline;
    await expect(repo.claim(first.token, owner)).rejects.toThrow();
    expect(await repo.lease()).toBeNull();
  });
  it('rejects expired, nonfinite, and overlong reply deadlines', async () => {
    for (const deadline of [now, now - 1, Number.NaN, Number.POSITIVE_INFINITY, now + 86_400_001]) {
      await expect(repo.startLink(sender, 'wamid.invalid-deadline', deadline)).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
  it('rejects reassignment and revokes queued content on disconnect', async () => {
    const { token } = await repo.startLink(sender, 'wamid.first');
    await repo.confirm(token, owner, await codeFor(token), 'whatsapp-general-agent-v1');
    const other = await repo.startLink('46707654321', 'wamid.other');
    await expect(repo.claim(other.token, owner)).rejects.toThrow();
    await repo.enqueue({ id: 'wamid.msg', sender, payload: { kind: 'incoming', text: 'private text' }, expiresAt: now + 60_000 });
    await repo.disconnect(owner);
    expect(await repo.getConnection(owner)).toBeNull();
    expect(await repo.lease()).toBeNull();
    const row = await sql<{payload: string | null}>`SELECT payload FROM whatsapp_jobs WHERE id='wamid.msg'`.execute(db.kysely);
    expect(row.rows[0]?.payload).toBeNull();
  });
  it('serializes simultaneous claims and prevents the same sender linking to another owner', async () => {
    const { token } = await repo.startLink(sender, 'wamid.first');
    const outcomes = await Promise.allSettled([repo.claim(token, owner), repo.claim(token, 'user_other')]);
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const winner = outcomes[0]!.status === 'fulfilled' ? owner : 'user_other';
    const verification = await repo.lease();
    const code = String(verification!.payload.text).match(/\b\d{6}\b/)![0];
    await repo.confirm(token, winner, code, 'whatsapp-general-agent-v1');
    const next = await repo.startLink(sender, 'wamid.next');
    await expect(repo.claim(next.token, winner === owner ? 'user_other' : owner)).rejects.toThrow();
  });
  it('links a Meta business-scoped user ID without exposing its opaque identifier', async () => {
    const bsuid = 'SE.123456789';
    const { token } = await repo.startLink(bsuid, 'wamid.bsuid');
    expect(await repo.claim(token, owner)).toEqual({ maskedSender: 'WhatsApp account' });
    await repo.confirm(token, owner, await codeFor(token), 'whatsapp-general-agent-v1');
    expect(await repo.getConnectionBySender(bsuid)).toMatchObject({ sender: bsuid, owner });
  });
  it('keeps the proven phone encrypted through linking and verification', async () => {
    const { token } = await repo.startLink('SE.opaque', 'wamid.paired', now + 60_000, sender);
    await repo.claim(token, owner);
    const verification = await repo.lease();
    expect(verification?.sender).toBe('SE.opaque');
    expect(verification?.payload.phone).toBe(sender);
    const row = await sql<{ token_cipher: string }>`SELECT token_cipher FROM whatsapp_link_challenges WHERE request_id='wamid.paired'`.execute(db.kysely);
    expect(row.rows[0]?.token_cipher).not.toContain(sender);
  });
  it('rejects invalid delivery phones and does not replace the original proof on replay', async () => {
    await expect(repo.startLink('SE.opaque', 'wamid.invalid-phone', now + 60_000, '+46700000000')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(repo.stop('SE.opaque', 'wamid.invalid-stop', now + 60_000, now, 'not-phone')).rejects.toMatchObject({ code: 'invalid_input' });
    const original = await repo.startLink('SE.opaque', 'wamid.phone-replay', now + 60_000, sender);
    expect(await repo.startLink('SE.opaque', 'wamid.phone-replay', now + 60_000, '46707654321')).toEqual(original);
    await repo.claim(original.token, owner);
    expect((await repo.lease())?.payload.phone).toBe(sender);
  });
  it('preserves the signed phone on a STOP acknowledgement', async () => {
    await repo.stop('SE.opaque', 'wamid.paired-stop', now + 60_000, now, sender);
    const acknowledgement = await repo.lease();
    expect(acknowledgement?.sender).toBe('SE.opaque');
    expect(acknowledgement?.payload.phone).toBe(sender);
  });
  it('revokes immediately on STOP and does not revoke a later connection on replay', async () => {
    const first = await repo.startLink(sender, 'wamid.first');
    const previous = await repo.confirm(first.token, owner, await codeFor(first.token), 'whatsapp-general-agent-v1');
    await repo.enqueue({ id: 'wamid.pending', sender, payload: { kind: 'run', private: 'queued content' }, expiresAt: now + 60_000 });
    expect(await repo.stop(sender, 'wamid.stop', now + 60_000, now)).toBe(true);
    expect(await repo.getConnection(owner)).toBeNull();
    const acknowledgement = await repo.lease();
    expect(acknowledgement?.id).toBe('stop:wamid.stop');
    await repo.finish(acknowledgement!.id, acknowledgement!.fence, 'complete');
    const second = await repo.startLink(sender, 'wamid.second');
    const current = await repo.confirm(second.token, owner, await codeFor(second.token), 'whatsapp-general-agent-v1');
    expect(current.id).not.toBe(previous.id);
    expect(await repo.stop(sender, 'wamid.stop', now + 60_000, now)).toBe(false);
    expect((await repo.getConnection(owner))?.id).toBe(current.id);
  });
  it('commits STOP at saturated capacity and retains a terminal replay marker after relinking', async () => {
    const first = await repo.startLink(sender, 'wamid.capacity-link');
    await repo.confirm(first.token, owner, await codeFor(first.token), 'whatsapp-general-agent-v1');
    const ciphertext = encryptWhatsAppPayload({ kind: 'incoming', text: 'Queued elsewhere' }, key);
    await sql`INSERT INTO whatsapp_jobs(id,sender,payload,state,available_at,expires_at,created_at)
      SELECT 'wamid.saturated.' || n::text, '46' || lpad(n::text,9,'0'), ${ciphertext},
        'ready', ${now}, ${now + 120_000}, ${now}
      FROM generate_series(1,10000) AS n`.execute(db.kysely);
    await expect(repo.enqueue({ id: 'wamid.full', sender, payload: {}, expiresAt: now + 60_000 }))
      .rejects.toMatchObject({ code: 'capacity' });
    expect(await repo.stop(sender, 'wamid.capacity-stop', now + 60_000, now)).toBe(true);
    expect(await repo.getConnectionBySender(sender)).toBeNull();
    const marker = await sql<{state: string; payload: string | null; fence: string | null; lease_expires_at: number | null}>`
      SELECT state,payload,fence,lease_expires_at FROM whatsapp_jobs WHERE id='stop:wamid.capacity-stop'`.execute(db.kysely);
    expect(marker.rows).toEqual([{ state: 'complete', payload: null, fence: null, lease_expires_at: null }]);
    const active = await sql<{count: number}>`SELECT count(*) AS count FROM whatsapp_jobs WHERE state IN ('ready','leased','sending')`.execute(db.kysely);
    expect(Number(active.rows[0]!.count)).toBe(10_000);
    const revoked = await sql<{state: string; token_cipher: string; code_hash: string | null}>`
      SELECT state,token_cipher,code_hash FROM whatsapp_link_challenges WHERE request_id='wamid.capacity-link'`.execute(db.kysely);
    expect(revoked.rows).toEqual([{ state: 'blocked', token_cipher: '', code_hash: null }]);
    await sql`UPDATE whatsapp_jobs SET state='complete',payload=NULL,finished_at=${now} WHERE state='ready'`.execute(db.kysely);
    const second = await repo.startLink(sender, 'wamid.capacity-relink');
    const current = await repo.confirm(second.token, owner, await codeFor(second.token), 'whatsapp-general-agent-v1');
    expect(await repo.stop(sender, 'wamid.capacity-stop', now + 60_000, now)).toBe(false);
    expect((await repo.getConnection(owner))?.id).toBe(current.id);
    await finishConnectionConfirmation();
    expect(await repo.lease()).toBeNull();
    now += 7 * 86_400_000 + 1;
    await repo.cleanup();
    const retained = await sql`SELECT id FROM whatsapp_jobs WHERE id='stop:wamid.capacity-stop'`.execute(db.kysely);
    expect(retained.rows).toEqual([]);
  });
  it('rolls back STOP on acknowledgement database failure and permits a safe retry', async () => {
    const { token } = await repo.startLink(sender, 'wamid.database-link');
    const linked = await repo.confirm(token, owner, await codeFor(token), 'whatsapp-general-agent-v1');
    await repo.enqueue({ id: 'wamid.pending-stop', sender, payload: { kind: 'incoming' }, expiresAt: now + 60_000 });
    const original = client.query.bind(client);
    const failure = new Error('Database unavailable');
    const query = vi.spyOn(client, 'query').mockImplementation(async (...args: Parameters<typeof client.query>) => {
      if (args[0].startsWith('insert into "whatsapp_jobs"')) throw failure;
      return original(...args);
    });
    await expect(repo.stop(sender, 'wamid.database-stop', now + 60_000, now)).rejects.toBe(failure);
    query.mockRestore();
    expect((await repo.getConnection(owner))?.id).toBe(linked.id);
    const pending = await sql<{state: string}>`SELECT state FROM whatsapp_jobs WHERE id='wamid.pending-stop'`.execute(db.kysely);
    expect(pending.rows[0]!.state).toBe('ready');
    const marker = await sql`SELECT id FROM whatsapp_jobs WHERE id='stop:wamid.database-stop'`.execute(db.kysely);
    expect(marker.rows).toEqual([]);
    expect(await repo.stop(sender, 'wamid.database-stop', now + 60_000, now)).toBe(true);
    expect(await repo.getConnection(owner)).toBeNull();
    expect((await repo.lease())?.id).toBe('stop:wamid.database-stop');
  });
  it('ignores a first-seen delayed STOP sent before a new association', async () => {
    const messageTimestamp = now;
    now += 3000;
    const { token } = await repo.startLink(sender, 'wamid.new');
    const current = await repo.confirm(token, owner, await codeFor(token), 'whatsapp-general-agent-v1');
    expect(await repo.stop(sender, 'wamid.old-stop', now + 60_000, messageTimestamp)).toBe(false);
    expect((await repo.getConnection(owner))?.id).toBe(current.id);
    await finishConnectionConfirmation();
    expect(await repo.lease()).toBeNull();
  });
  it('pins a chat to the verified association and runtime', async () => {
    const { token } = await repo.startLink(sender, 'wamid.first');
    await repo.confirm(token, owner, await codeFor(token), 'whatsapp-general-agent-v1');
    await repo.bindChat(owner, sender, 'machine1', 'chat1');
    await repo.bindChat(owner, sender, 'machine1', 'chat1');
    await expect(repo.bindChat(owner, sender, 'machine2', 'chat2')).rejects.toThrow();
    await expect(repo.bindChat(owner, '46700000000', 'machine1', 'chat1')).rejects.toThrow();
  });
  it('replaces a deleted Chat only with the same association, runtime and expected previous Chat', async () => {
    const { token } = await repo.startLink(sender, 'wamid.replace');
    const linked = await repo.confirm(token, owner, await codeFor(token), 'whatsapp-general-agent-v1');
    await repo.bindChat(owner, sender, 'machine1', 'chat_old', linked.id);
    await expect(repo.bindChat(owner, sender, 'machine1', 'chat_new', undefined, 'chat_old')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(repo.bindChat(owner, sender, 'machine1', 'chat_new', linked.id, 'chat_other')).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.bindChat(owner, sender, 'machine2', 'chat_new', linked.id, 'chat_old')).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.bindChat(owner, sender, 'machine1', 'chat_new', 'stale-epoch', 'chat_old')).rejects.toMatchObject({ code: 'conflict' });
    await repo.bindChat(owner, sender, 'machine1', 'chat_new', linked.id, 'chat_old');
    await repo.bindChat(owner, sender, 'machine1', 'chat_new', linked.id, 'chat_old');
    await expect(repo.bindChat(owner, sender, 'machine1', 'chat_third', linked.id, 'chat_old')).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.getConnection(owner))?.chatId).toBe('chat_new');
  });
  it('revokes claimed proof by owner before linking and by sender after linking', async () => {
    const first = await repo.startLink(sender, 'wamid.owner-revoke');
    await repo.claim(first.token, owner);
    const hash = createHash('sha256').update(first.token).digest('hex');
    expect(await repo.isChallengeActive(hash, owner)).toBe(true);
    expect(await repo.isChallengeActive(hash, 'other_owner')).toBe(false);
    expect(await repo.isChallengeActive('invalid', owner)).toBe(false);
    await repo.disconnect(owner);
    expect(await repo.isChallengeActive(hash, owner)).toBe(false);
    await expect(repo.confirm(first.token, owner, '000000', 'whatsapp-general-agent-v1')).rejects.toThrow();
    await repo.disconnectBySender(sender);
    const second = await repo.startLink(sender, 'wamid.sender-revoke');
    const current = await repo.confirm(second.token, owner, await codeFor(second.token), 'whatsapp-general-agent-v1');
    await expect(repo.bindChat(owner, sender, 'machine1', 'chat1', 'stale-connection')).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.bindChat(owner, sender, 'machine1', 'chat1', current.id)).id).toBe(current.id);
    await repo.disconnectBySender(sender);
    expect(await repo.getConnectionBySender(sender)).toBeNull();
  });
  it('stops unlinked senders without letting a delayed STOP erase a newer proof', async () => {
    const oldTimestamp = now;
    now += 3000;
    const first = await repo.startLink(sender, 'wamid.new-proof');
    expect(await repo.stop(sender, 'wamid.old-stop-proof', now + 60_000, oldTimestamp)).toBe(false);
    await repo.claim(first.token, owner);
    expect(await repo.stop(sender, 'wamid.new-stop-proof', now + 60_000, now)).toBe(true);
    await expect(repo.claim(first.token, owner)).rejects.toThrow();
    expect((await repo.lease())?.id).toBe('stop:wamid.new-stop-proof');
  });
  it('rejects malformed identities, token proof and unsafe STOP timestamps', async () => {
    await expect(repo.startLink('../unsafe', 'wamid.a')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(repo.startLink(sender, 'unsafe id')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(repo.getConnection('../unsafe')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(repo.claim('bad-token', owner)).rejects.toMatchObject({ code: 'invalid_link' });
    await expect(repo.stop(sender, 'wamid.stop', now + 60_000, now + 300_001)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(repo.stop(sender, 'wamid.stop', now + 60_000, now - 86_400_001)).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('rejects expired or consumed link replay and bounds outstanding proofs', async () => {
    const first = await repo.startLink(sender, 'wamid.first');
    await repo.confirm(first.token, owner, await codeFor(first.token), 'whatsapp-general-agent-v1');
    await expect(repo.startLink(sender, 'wamid.first')).rejects.toMatchObject({ code: 'invalid_link' });
    for (let i = 0; i < 9; i++) await repo.startLink(sender, `wamid.proof${i}`);
    await expect(repo.startLink(sender, 'wamid.proof-overflow')).rejects.toMatchObject({ code: 'capacity' });
    now += 600_001;
    await expect(repo.startLink(sender, 'wamid.proof0')).rejects.toMatchObject({ code: 'invalid_link' });
  });
  it('recovers a concurrent request-id insert winner without transferring its sender', async () => {
    const first = await repo.startLink(sender, 'wamid.race');
    const original = client.query.bind(client);
    function hideInitialSnapshot() {
      let hidden = false;
      return vi.spyOn(client, 'query').mockImplementation(async (...args: Parameters<typeof client.query>) => {
        const result = await original(...args);
        if (!hidden && args[0].startsWith('select * from "whatsapp_link_challenges" where "request_id"')) {
          hidden = true;
          return { ...result, rows: [] };
        }
        return result;
      });
    }
    const same = hideInitialSnapshot();
    expect(await repo.startLink(sender, 'wamid.race')).toEqual(first);
    same.mockRestore();
    hideInitialSnapshot();
    await expect(repo.startLink('46707654321', 'wamid.race')).rejects.toMatchObject({ code: 'invalid_link' });
  });
  it.each([owner, 'other_owner'])('handles a competing claim before conditional update for %s', async (winner) => {
    const { token } = await repo.startLink(sender, 'wamid.claim-race');
    const hash = createHash('sha256').update(token).digest('hex');
    const original = client.query.bind(client);
    let competed = false;
    vi.spyOn(client, 'query').mockImplementation(async (...args: Parameters<typeof client.query>) => {
      if (!competed && args[0].startsWith('update "whatsapp_link_challenges" set "state"')) {
        competed = true;
        await original('UPDATE whatsapp_link_challenges SET state=$1,owner=$2,code_hash=$3 WHERE token_hash=$4',
          ['claimed', winner, hashWhatsAppCode('123456', key), hash]);
        await original('INSERT INTO whatsapp_jobs(id,sender,payload,state,available_at,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [`verification:${hash}`, sender, encryptWhatsAppPayload({ kind: 'verification', owner: winner, tokenHash: hash, text: 'Code 123456' }, key), 'ready', now, now + 600_000, now]);
      }
      return original(...args);
    });
    if (winner === owner) {
      expect(await repo.claim(token, owner)).toEqual({ maskedSender: '••••4567' });
      expect((await repo.lease())?.payload.text).toBe('Code 123456');
    } else await expect(repo.claim(token, owner)).rejects.toMatchObject({ code: 'invalid_link' });
  });
  it('does not reassign an owner when another outstanding proof is confirmed first', async () => {
    const first = await repo.startLink(sender, 'wamid.pending-proof');
    const firstCode = await codeFor(first.token);
    const second = await repo.startLink('46707654321', 'wamid.winning-proof');
    const winner = await repo.confirm(second.token, owner, await codeFor(second.token), 'whatsapp-general-agent-v1');
    await expect(repo.confirm(first.token, owner, firstCode, 'whatsapp-general-agent-v1')).rejects.toMatchObject({ code: 'invalid_link' });
    expect(await repo.getConnection(owner)).toMatchObject({ id: winner.id, sender: '46707654321' });
  });
  it('rolls back connection creation when the proof changes before final consumption', async () => {
    const { token } = await repo.startLink(sender, 'wamid.consume-race');
    const code = await codeFor(token);
    const original = client.query.bind(client);
    let competed = false;
    vi.spyOn(client, 'query').mockImplementation(async (...args: Parameters<typeof client.query>) => {
      if (!competed && args[0].startsWith('update "whatsapp_link_challenges" set "state"')) {
        competed = true;
        await original('UPDATE whatsapp_link_challenges SET state=$1 WHERE request_id=$2', ['blocked', 'wamid.consume-race']);
      }
      return original(...args);
    });
    await expect(repo.confirm(token, owner, code, 'whatsapp-general-agent-v1')).rejects.toMatchObject({ code: 'invalid_link' });
    expect(await repo.getConnection(owner)).toBeNull();
  });
});

describe('WhatsApp durable jobs', () => {
  async function enqueue(id: string, phone = sender) {
    return repo.enqueue({ id, sender: phone, payload: { kind: 'incoming', text: 'Secret content' }, expiresAt: now + 120_000 });
  }
  it('deduplicates IDs, encrypts content and erases completed payloads', async () => {
    expect(await enqueue('wamid.a')).toBe(true);
    expect(await enqueue('wamid.a')).toBe(false);
    const raw = await sql<{payload: string}>`SELECT payload FROM whatsapp_jobs WHERE id='wamid.a'`.execute(db.kysely);
    expect(raw.rows[0]!.payload).not.toContain('Secret content');
    expect(decryptWhatsAppPayload(raw.rows[0]!.payload, key)).toMatchObject({ text: 'Secret content' });
    const job = await repo.lease();
    expect(job?.payload.text).toBe('Secret content');
    expect(await repo.finish(job!.id, job!.fence, 'complete')).toBe(true);
    const done = await sql<{payload: string | null}>`SELECT payload FROM whatsapp_jobs WHERE id='wamid.a'`.execute(db.kysely);
    expect(done.rows[0]!.payload).toBeNull();
  });
  it('serializes sender jobs, recovers expired leases and fences stale workers', async () => {
    await enqueue('wamid.a'); await enqueue('wamid.b'); await enqueue('wamid.c', '46707654321');
    const a = await repo.lease();
    const c = await repo.lease();
    expect(a?.id).toBe('wamid.a'); expect(c?.id).toBe('wamid.c');
    expect(await repo.lease()).toBeNull();
    now += 61_000;
    const replacement = await repo.lease();
    expect(replacement?.id).toBe('wamid.a');
    expect(replacement?.fence).not.toBe(a?.fence);
    expect(await repo.checkpoint(a!.id, a!.fence, { kind: 'incoming', text: 'stale' })).toBe(false);
    expect(await repo.finish(a!.id, a!.fence, 'complete')).toBe(false);
    expect(await repo.finish(replacement!.id, replacement!.fence, 'complete')).toBe(true);
    expect((await repo.lease())?.id).toBe('wamid.b');
  });
  it('quarantines corrupt ciphertext durably so another sender can drain', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await enqueue('wamid.corrupt');
    await enqueue('wamid.other', '46707654321');
    await sql`UPDATE whatsapp_jobs SET payload='v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA' WHERE id='wamid.corrupt'`.execute(db.kysely);
    expect(await repo.lease()).toBeNull();
    const quarantined = await sql<{state: string; payload: string | null; fence: string | null; lease_expires_at: number | null}>`
      SELECT state,payload,fence,lease_expires_at FROM whatsapp_jobs WHERE id='wamid.corrupt'
    `.execute(db.kysely);
    expect(quarantined.rows[0]).toEqual({ state: 'failed', payload: null, fence: null, lease_expires_at: null });
    expect(log).toHaveBeenCalledWith('[whatsapp] Removed unreadable queued payload');
    expect((await repo.lease())?.id).toBe('wamid.other');
  });
  it('lets newer senders drain while two older runs repeatedly poll', async () => {
    await enqueue('wamid.run-a');
    await enqueue('wamid.run-b', '46707654321');
    const first = await repo.lease();
    expect(first?.id).toBe('wamid.run-a');
    await repo.retry(first!.id, first!.fence, 2000);
    now += 1000;
    const second = await repo.lease();
    expect(second?.id).toBe('wamid.run-b');
    await repo.retry(second!.id, second!.fence, 2000);
    await enqueue('wamid.new-sender', '46700000001');
    now += 1000;
    expect((await repo.lease())?.id).toBe('wamid.new-sender');
  });
  it('never replays an ambiguous send after an expired lease', async () => {
    await enqueue('wamid.a');
    const job = await repo.lease();
    expect(await repo.markSending(job!.id, job!.fence)).toBe(true);
    now += 61_000;
    expect(await repo.lease()).toBeNull();
    const state = await sql<{state: string; payload: string | null}>`SELECT state,payload FROM whatsapp_jobs WHERE id='wamid.a'`.execute(db.kysely);
    expect(state.rows[0]).toEqual({ state: 'unknown', payload: null });
  });
  it('keeps retry order and bounds backlog', async () => {
    await enqueue('wamid.a'); await enqueue('wamid.b');
    const a = await repo.lease();
    expect(await repo.retry(a!.id, a!.fence, 10_000)).toBe(true);
    expect(await repo.lease()).toBeNull();
    now += 10_001;
    expect((await repo.lease())?.id).toBe('wamid.a');
    for (let i = 0; i < 98; i++) await enqueue(`wamid.cap${i}`);
    await expect(enqueue('wamid.overflow')).rejects.toThrow();
    now += 121_000;
    await repo.cleanup();
    expect(await repo.lease()).toBeNull();
    expect(await enqueue('wamid.after')).toBe(true);
  });
  it('rejects expired, excessive, and malformed durable jobs and transition arguments', async () => {
    for (const expiresAt of [now, Number.NaN, now + 86_400_001]) {
      await expect(repo.enqueue({ id: 'wamid.invalid', sender, payload: {}, expiresAt })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(repo.enqueue({ id: 'wamid.large', sender, payload: { text: 'x'.repeat(65_537) }, expiresAt: now + 1000 })).rejects.toThrow('payload is too large');
    await expect(repo.retry('wamid.none', 'no-fence', -1)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(repo.finish('wamid.none', 'no-fence', 'ready' as never)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await repo.checkpoint('wamid.none', 'no-fence', {})).toBe(false);
    expect(await repo.markSending('wamid.none', 'no-fence')).toBe(false);
  });
});
