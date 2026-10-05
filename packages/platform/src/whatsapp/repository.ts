import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { PlatformDB } from '../db.js';
import { WhatsAppPhoneSchema } from './config.js';
import { compareWhatsAppCode, hashWhatsAppCode, decryptWhatsAppPayload, encryptWhatsAppPayload, hashWhatsAppSecret, whatsappEncryptionKey } from './crypto.js';
import {
  WHATSAPP_AGENT_CONSENT_VERSION,
  type WhatsAppConnection, type WhatsAppDatabase, type WhatsAppEnqueueInput,
  type WhatsAppJob, type WhatsAppJobTerminalState,
} from './repository-types.js';
export { WHATSAPP_AGENT_CONSENT_VERSION } from './repository-types.js';
export type { WhatsAppConnection, WhatsAppJob, WhatsAppEnqueueInput } from './repository-types.js';

export class WhatsAppRepositoryError extends Error {
  constructor(public readonly code: 'invalid_link' | 'capacity' | 'invalid_input' | 'conflict') {
    super('Unable to complete WhatsApp request');
    this.name = 'WhatsAppRepositoryError';
  }
}

class WhatsAppPayloadDecryptionError extends Error {
  constructor() { super('Unreadable queued WhatsApp payload'); }
}
function decodeJobPayload(value: string, key: Buffer): Record<string, unknown> {
  // Only the pure decoder is inside this boundary. Pool/query failures never
  // become decryption failures and remain visible to the caller.
  try { return decryptWhatsAppPayload(value, key); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new WhatsAppPayloadDecryptionError();
  }
}

type DB = Transaction<WhatsAppDatabase>;
type ConnectionRow = WhatsAppDatabase['whatsapp_connections'];
const ACTIVE = ['ready', 'leased', 'sending'];
const LEASE_MS = 60_000;
const DAY_MS = 86_400_000;
const maskSender = (sender: string): string => /^[1-9]\d+$/.test(sender) ? `••••${sender.slice(-4)}` : 'WhatsApp account';
const connection = (row: ConnectionRow): WhatsAppConnection => ({
  id: row.id, owner: row.owner, sender: row.sender, chatId: row.chat_id,
  machineId: row.machine_id, consentVersion: row.consent_version,
});
function validateSender(sender: string): void {
  if (!/^[1-9]\d{6,14}$/.test(sender) && !/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(sender)) throw new WhatsAppRepositoryError('invalid_input');
}
function validateId(id: string): void {
  if (!/^[\w.:=+/-]{1,512}$/.test(id)) throw new WhatsAppRepositoryError('invalid_input');
}
function validateOwner(owner: string): void {
  if (!/^[\w-]{1,128}$/.test(owner)) throw new WhatsAppRepositoryError('invalid_input');
}
function tokenHash(token: string): string {
  if (!/^[\w-]{43}$/.test(token)) throw new WhatsAppRepositoryError('invalid_link');
  return hashWhatsAppSecret(token);
}

/** Uses the injected pool without owning or closing it. A short transaction
 * advisory lock serializes pilot mutations, ensuring queue order and account
 * uniqueness across platform processes; no external calls happen under it. */
export function createWhatsAppRepository(platform: PlatformDB, configuredKey: Buffer | string, now: () => number = Date.now) {
  const key = whatsappEncryptionKey(configuredKey);
  const db = platform.kysely as unknown as Kysely<WhatsAppDatabase>;
  // Bound local admission as well as cross-process locking. This prevents an
  // inbound burst from occupying an unbounded pool wait queue.
  let pendingTransactions = 0;
  let transactionTail: Promise<void> = Promise.resolve();
  async function transaction<T>(work: (trx: DB) => Promise<T>): Promise<T> {
    if (pendingTransactions >= 1000) throw new WhatsAppRepositoryError('capacity');
    pendingTransactions += 1;
    const result = transactionTail.then(async () => {
      await platform.ready;
      return platform.transaction(async (scoped) => {
        const trx = scoped.executor as unknown as DB;
        await sql`SELECT pg_advisory_xact_lock(5460001)`.execute(trx);
        return work(trx);
      });
    });
    // Rejections remain observable through result; only queue continuation is
    // normalized, so a rejected request cannot poison subsequent operations.
    transactionTail = result.then(() => undefined, () => undefined);
    try { return await result; }
    finally { pendingTransactions -= 1; }
  }
  async function expireJobs(trx: DB, time: number): Promise<void> {
    await trx.updateTable('whatsapp_jobs').set({ state: 'expired', payload: null, fence: null, lease_expires_at: null, finished_at: time })
      .where('state', 'in', ACTIVE).where('expires_at', '<=', time).execute();
    // A request could have reached Meta even if the process lost its response.
    // An expired sending lease is terminal and must never be delivered again.
    await trx.updateTable('whatsapp_jobs').set({ state: 'unknown', payload: null, fence: null, lease_expires_at: null, finished_at: time })
      .where('state', '=', 'sending').where('lease_expires_at', '<=', time).execute();
    await trx.updateTable('whatsapp_jobs').set({ state: 'ready', fence: null, lease_expires_at: null })
      .where('state', '=', 'leased').where('lease_expires_at', '<=', time).execute();
  }
  async function insertJob(trx: DB, input: WhatsAppEnqueueInput, time: number): Promise<boolean> {
    validateId(input.id); validateSender(input.sender);
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= time || input.expiresAt > time + DAY_MS) {
      throw new WhatsAppRepositoryError('invalid_input');
    }
    const duplicate = await trx.selectFrom('whatsapp_jobs').select('id').where('id', '=', input.id).executeTakeFirst();
    if (duplicate) return false;
    await expireJobs(trx, time);
    const counts = await trx.selectFrom('whatsapp_jobs').select((eb) => eb.fn.countAll<number>().as('count'))
      .where('state', 'in', ACTIVE).executeTakeFirstOrThrow();
    const senderCounts = await trx.selectFrom('whatsapp_jobs').select((eb) => eb.fn.countAll<number>().as('count'))
      .where('state', 'in', ACTIVE).where('sender', '=', input.sender).executeTakeFirstOrThrow();
    if (Number(counts.count) >= 10_000 || Number(senderCounts.count) >= 100) throw new WhatsAppRepositoryError('capacity');
    const row = await trx.insertInto('whatsapp_jobs').values({
      id: input.id, sender: input.sender, payload: encryptWhatsAppPayload(input.payload, key),
      state: 'ready', attempts: 0, fence: null, lease_expires_at: null,
      available_at: time, expires_at: input.expiresAt, created_at: time, finished_at: null,
    }).onConflict((oc) => oc.column('id').doNothing()).returning('id').executeTakeFirst();
    return !!row;
  }
  async function getConnection(owner: string): Promise<WhatsAppConnection | null> {
    validateOwner(owner); await platform.ready;
    const row = await db.selectFrom('whatsapp_connections').selectAll().where('owner', '=', owner).executeTakeFirst();
    return row ? connection(row) : null;
  }
  async function getConnectionBySender(sender: string): Promise<WhatsAppConnection | null> {
    validateSender(sender); await platform.ready;
    const row = await db.selectFrom('whatsapp_connections').selectAll().where('sender', '=', sender).executeTakeFirst();
    return row ? connection(row) : null;
  }
  async function revoke(trx: DB, owner: string, sender: string, time: number): Promise<void> {
    await trx.deleteFrom('whatsapp_connections').where('owner', '=', owner).where('sender', '=', sender).execute();
    await trx.updateTable('whatsapp_jobs').set({ state: 'revoked', payload: null, fence: null, lease_expires_at: null, finished_at: time })
      .where('sender', '=', sender).where('state', 'in', ACTIVE).execute();
    await trx.updateTable('whatsapp_link_challenges').set({ state: 'blocked', code_hash: null, token_cipher: '' })
      .where((eb) => eb.or([eb('owner', '=', owner), eb('sender', '=', sender)])).execute();
  }
  async function disconnect(owner: string): Promise<void> {
    validateOwner(owner);
    await transaction(async (trx) => {
      const row = await trx.selectFrom('whatsapp_connections').selectAll().where('owner', '=', owner).executeTakeFirst();
      if (row) await revoke(trx, owner, row.sender, now());
      else await trx.updateTable('whatsapp_link_challenges').set({ state: 'blocked', token_cipher: '', code_hash: null })
        .where('owner', '=', owner).execute();
    });
  }
  async function disconnectBySender(sender: string): Promise<void> {
    validateSender(sender);
    await transaction(async (trx) => {
      const row = await trx.selectFrom('whatsapp_connections').selectAll().where('sender', '=', sender).executeTakeFirst();
      if (row) await revoke(trx, row.owner, sender, now());
      else {
        await trx.updateTable('whatsapp_link_challenges').set({ state: 'blocked', token_cipher: '', code_hash: null })
          .where('sender', '=', sender).execute();
        await trx.updateTable('whatsapp_jobs').set({ state: 'revoked', payload: null, fence: null, lease_expires_at: null, finished_at: now() })
          .where('sender', '=', sender).where('state', 'in', ACTIVE).execute();
      }
    });
  }
  async function stop(sender: string, messageId: string, expiresAt: number, messageTimestampMs: number, phone?: string): Promise<boolean> {
    if (phone !== undefined && !WhatsAppPhoneSchema.safeParse(phone).success) throw new WhatsAppRepositoryError('invalid_input');
    validateSender(sender); validateId(messageId);
    return transaction(async (trx) => {
      const time = now();
      if (!Number.isSafeInteger(messageTimestampMs) || messageTimestampMs <= 0 || messageTimestampMs > time + 300_000 ||
        messageTimestampMs < time - DAY_MS || !Number.isSafeInteger(expiresAt) || expiresAt <= time || expiresAt > messageTimestampMs + DAY_MS) {
        throw new WhatsAppRepositoryError('invalid_input');
      }
      const ackId = `stop:${messageId}`;
      const duplicate = await trx.selectFrom('whatsapp_jobs').select('id').where('id', '=', ackId).executeTakeFirst();
      if (duplicate) return false;
      const current = await trx.selectFrom('whatsapp_connections').selectAll().where('sender', '=', sender).executeTakeFirst();
      // Meta event timestamps have second precision. Admit a one-second skew,
      // but never let a delayed old STOP revoke a newer verified association.
      if (current && current.created_at > messageTimestampMs + 1000) return false;
      if (current) await revoke(trx, current.owner, sender, time);
      else {
        const newerProof = await trx.selectFrom('whatsapp_link_challenges').select('token_hash').where('sender', '=', sender)
          .where('state', 'in', ['open', 'claimed']).where('expires_at', '>', time)
          .where('created_at', '>', messageTimestampMs + 1000).executeTakeFirst();
        if (newerProof) return false;
        await trx.updateTable('whatsapp_link_challenges').set({ state: 'blocked', token_cipher: '', code_hash: null })
          .where('sender', '=', sender).execute();
        await trx.updateTable('whatsapp_jobs').set({ state: 'revoked', payload: null, fence: null, lease_expires_at: null, finished_at: time })
          .where('sender', '=', sender).where('state', 'in', ACTIVE).execute();
      }
      try {
        await insertJob(trx, { id: ackId, sender, expiresAt,
          payload: { kind: 'reply', ...(phone ? { phone } : {}), text: 'WhatsApp disconnected. Your Matrix Chat is still available in Matrix.' } }, time);
      } catch (error) {
        // Queue admission raises this typed capacity error before attempting
        // its INSERT. A full delivery queue must not undo STOP revocation.
        // Database failures still abort the transaction and remain retryable.
        if (!(error instanceof WhatsAppRepositoryError && error.code === 'capacity')) throw error;
        await trx.insertInto('whatsapp_jobs').values({
          id: ackId, sender, payload: null, state: 'complete', attempts: 0,
          fence: null, lease_expires_at: null, available_at: time,
          expires_at: expiresAt, created_at: time, finished_at: time,
        }).onConflict((oc) => oc.column('id').doNothing()).execute();
      }
      return true;
    });
  }
  async function startLink(sender: string, requestId: string, replyDeadline?: number, phone?: string): Promise<{ token: string }> {
    validateSender(sender); validateId(requestId);
    if (phone !== undefined && !WhatsAppPhoneSchema.safeParse(phone).success) throw new WhatsAppRepositoryError('invalid_input');
    return transaction(async (trx) => {
      const time = now();
      if (replyDeadline !== undefined && (!Number.isSafeInteger(replyDeadline) || replyDeadline <= time || replyDeadline > time + DAY_MS)) {
        throw new WhatsAppRepositoryError('invalid_input');
      }
      const existing = await trx.selectFrom('whatsapp_link_challenges').selectAll().where('request_id', '=', requestId).executeTakeFirst();
      if (existing) {
        if (existing.sender !== sender || existing.expires_at <= time || !['open', 'claimed'].includes(existing.state)) {
          throw new WhatsAppRepositoryError('invalid_link');
        }
        return { token: String(decryptWhatsAppPayload(existing.token_cipher, key).token) };
      }
      const count = await trx.selectFrom('whatsapp_link_challenges').select((eb) => eb.fn.countAll<number>().as('count'))
        .where('sender', '=', sender).where('expires_at', '>', time).executeTakeFirstOrThrow();
      const globalCount = await trx.selectFrom('whatsapp_link_challenges').select((eb) => eb.fn.countAll<number>().as('count'))
        .where('expires_at', '>', time).executeTakeFirstOrThrow();
      if (Number(count.count) >= 10 || Number(globalCount.count) >= 10_000) throw new WhatsAppRepositoryError('capacity');
      const token = randomBytes(32).toString('base64url');
      const inserted = await trx.insertInto('whatsapp_link_challenges').values({
        token_hash: hashWhatsAppSecret(token), request_id: requestId, sender,
        token_cipher: encryptWhatsAppPayload({ token, replyDeadline: replyDeadline ?? time + DAY_MS, ...(phone ? { phone } : {}) }, key), owner: null, code_hash: null,
        attempts: 0, state: 'open', created_at: time, expires_at: Math.min(time + 10 * 60_000, replyDeadline ?? time + DAY_MS),
      }).onConflict((oc) => oc.column('request_id').doNothing()).returning('token_hash').executeTakeFirst();
      if (!inserted) {
        const persisted = await trx.selectFrom('whatsapp_link_challenges').selectAll().where('request_id', '=', requestId).executeTakeFirst();
        if (!persisted || persisted.sender !== sender || persisted.expires_at <= time || !['open', 'claimed'].includes(persisted.state)) throw new WhatsAppRepositoryError('invalid_link');
        return { token: String(decryptWhatsAppPayload(persisted.token_cipher, key).token) };
      }
      return { token };
    });
  }
  async function claim(token: string, owner: string): Promise<{ maskedSender: string }> {
    const hash = tokenHash(token); validateOwner(owner);
    return transaction(async (trx) => {
      const time = now();
      const challenge = await trx.selectFrom('whatsapp_link_challenges').selectAll().where('token_hash', '=', hash).forUpdate().executeTakeFirst();
      if (!challenge || challenge.expires_at <= time || !['open', 'claimed'].includes(challenge.state) || challenge.attempts >= 5 ||
        (challenge.owner && challenge.owner !== owner)) throw new WhatsAppRepositoryError('invalid_link');
      const conflicting = await trx.selectFrom('whatsapp_connections').selectAll()
        .where((eb) => eb.or([eb('owner', '=', owner), eb('sender', '=', challenge.sender)])).execute();
      if (conflicting.some((row) => row.owner !== owner || row.sender !== challenge.sender)) throw new WhatsAppRepositoryError('invalid_link');
      if (challenge.state === 'open') {
        const proof = decryptWhatsAppPayload(challenge.token_cipher, key);
        const phone = WhatsAppPhoneSchema.optional().parse(proof.phone);
        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        const claimed = await trx.updateTable('whatsapp_link_challenges').set({ state: 'claimed', owner, code_hash: hashWhatsAppCode(code, key) })
          .where('token_hash', '=', hash).where('state', '=', 'open').where('owner', 'is', null).returning('token_hash').executeTakeFirst();
        if (!claimed) {
          const winner = await trx.selectFrom('whatsapp_link_challenges').selectAll().where('token_hash', '=', hash).executeTakeFirst();
          if (winner?.owner === owner && winner.state === 'claimed' && winner.expires_at > time && winner.attempts < 5) {
            return { maskedSender: maskSender(winner.sender) };
          }
          throw new WhatsAppRepositoryError('invalid_link');
        }
        await insertJob(trx, {
          id: `verification:${hash}`, sender: challenge.sender,
          payload: { kind: 'verification', owner, tokenHash: hash, ...(phone ? { phone } : {}), text: `Your Matrix connection code is ${code}. Enter it in Matrix. Never share this code.` },
          expiresAt: challenge.expires_at,
        }, time);
      }
      return { maskedSender: maskSender(challenge.sender) };
    });
  }
  async function confirm(token: string, owner: string, code: string, consentVersion?: string): Promise<WhatsAppConnection> {
    const hash = tokenHash(token); validateOwner(owner);
    if (consentVersion !== WHATSAPP_AGENT_CONSENT_VERSION || !/^\d{6}$/.test(code)) throw new WhatsAppRepositoryError('invalid_link');
    const result = await transaction(async (trx): Promise<WhatsAppConnection | null> => {
      const time = now();
      const challenge = await trx.selectFrom('whatsapp_link_challenges').selectAll().where('token_hash', '=', hash).forUpdate().executeTakeFirst();
      if (!challenge || challenge.owner !== owner || challenge.state !== 'claimed' || challenge.expires_at <= time || challenge.attempts >= 5 || !challenge.code_hash) return null;
      if (!compareWhatsAppCode(code, challenge.code_hash, key)) {
        await trx.updateTable('whatsapp_link_challenges').set({ attempts: sql<number>`attempts + 1`, state: sql<string>`CASE WHEN attempts >= 4 THEN 'blocked' ELSE 'claimed' END` })
          .where('token_hash', '=', hash).where('owner', '=', owner).where('state', '=', 'claimed').where('attempts', '<', 5).execute();
        return null;
      }
      const conflicting = await trx.selectFrom('whatsapp_connections').selectAll()
        .where((eb) => eb.or([eb('owner', '=', owner), eb('sender', '=', challenge.sender)])).execute();
      if (conflicting.some((row) => row.owner !== owner || row.sender !== challenge.sender)) return null;
      await trx.insertInto('whatsapp_connections').values({ id: randomUUID(), owner, sender: challenge.sender, chat_id: null, machine_id: null, consent_version: consentVersion, created_at: time })
        .onConflict((oc) => oc.doNothing()).execute();
      const persisted = await trx.selectFrom('whatsapp_connections').selectAll().where('owner', '=', owner).executeTakeFirst();
      if (!persisted || persisted.sender !== challenge.sender) throw new WhatsAppRepositoryError('invalid_link');
      const proof = decryptWhatsAppPayload(challenge.token_cipher, key);
      const phone = WhatsAppPhoneSchema.optional().parse(proof.phone);
      // Older proofs did not retain the original reply deadline. Fail closed
      // at their challenge expiry rather than guessing a longer Meta window.
      const replyDeadline = proof.replyDeadline ?? challenge.expires_at;
      if (typeof replyDeadline !== 'number' || !Number.isSafeInteger(replyDeadline) ||
        replyDeadline < challenge.expires_at || replyDeadline > challenge.created_at + DAY_MS) {
        throw new WhatsAppRepositoryError('invalid_link');
      }
      const consumed = await trx.updateTable('whatsapp_link_challenges').set({ state: 'consumed', code_hash: null, token_cipher: '' }).where('token_hash', '=', hash)
        .where('state', '=', 'claimed').where('owner', '=', owner).where('attempts', '<', 5).where('expires_at', '>', time).returning('token_hash').executeTakeFirst();
      if (!consumed) throw new WhatsAppRepositoryError('invalid_link');
      await trx.updateTable('whatsapp_jobs').set({ state: 'revoked', payload: null, fence: null, lease_expires_at: null, finished_at: time })
        .where('id', '=', `verification:${hash}`).where('state', 'in', ACTIVE).execute();
      // Commit the acknowledgement with the verified association. Worker delivery
      // survives request-process restarts and rechecks consent before sending.
      await insertJob(trx, { id: `connected:${hash}`, sender: challenge.sender, expiresAt: Math.min(time + 10 * 60_000, replyDeadline),
        payload: { kind: 'reply', owner, connectionId: persisted.id, ...(phone ? { phone } : {}),
          text: 'Your Matrix account is connected to WhatsApp. Send a message to talk to your Matrix agent. Send STOP to disconnect.' },
      }, time);
      return connection(persisted);
    });
    if (!result) throw new WhatsAppRepositoryError('invalid_link');
    return result;
  }
  async function isChallengeActive(hash: string, owner: string): Promise<boolean> {
    if (!/^[a-f\d]{64}$/.test(hash)) return false;
    validateOwner(owner); await platform.ready;
    const row = await db.selectFrom('whatsapp_link_challenges').select('token_hash')
      .where('token_hash', '=', hash).where('owner', '=', owner).where('state', '=', 'claimed')
      .where('attempts', '<', 5).where('expires_at', '>', now()).executeTakeFirst();
    return !!row;
  }
  async function bindChat(owner: string, sender: string, machineId: string, chatId: string, expectedConnectionId?: string, expectedPreviousChatId?: string): Promise<WhatsAppConnection> {
    validateOwner(owner); validateSender(sender); validateId(machineId); validateId(chatId);
    if (expectedPreviousChatId !== undefined) {
      validateId(expectedPreviousChatId);
      if (!expectedConnectionId) throw new WhatsAppRepositoryError('invalid_input');
    }
    return transaction(async (trx) => {
      const row = await trx.updateTable('whatsapp_connections').set({ machine_id: machineId, chat_id: chatId })
        .where('owner', '=', owner).where('sender', '=', sender)
        .$if(!!expectedConnectionId, (query) => query.where('id', '=', expectedConnectionId!))
        .where((eb) => eb.or([eb('machine_id', 'is', null), eb.and([eb('machine_id', '=', machineId), eb.or([eb('chat_id', '=', chatId), ...(expectedPreviousChatId ? [eb('chat_id', '=', expectedPreviousChatId)] : [])])])]))
        .returningAll().executeTakeFirst();
      if (!row) throw new WhatsAppRepositoryError('conflict');
      return connection(row);
    });
  }
  async function enqueue(input: WhatsAppEnqueueInput): Promise<boolean> {
    return transaction(async (trx) => {
      // An ingest snapshot taken before disconnect/deletion must not resurrect owner data.
      if (typeof input.payload.owner === 'string' && typeof input.payload.connectionId === 'string') {
        const current = await trx.selectFrom('whatsapp_connections').select('id')
          .where('owner', '=', input.payload.owner).where('sender', '=', input.sender)
          .where('id', '=', input.payload.connectionId).executeTakeFirst();
        if (!current) return false;
      }
      return insertJob(trx, input, now());
    });
  }
  async function lease(): Promise<WhatsAppJob | null> {
    let quarantined = false;
    const job = await transaction(async (trx): Promise<WhatsAppJob | null> => {
      const time = now();
      await expireJobs(trx, time);
      const row = await trx.selectFrom('whatsapp_jobs as candidate').selectAll('candidate')
        .where('candidate.state', '=', 'ready').where('candidate.available_at', '<=', time)
        .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM whatsapp_jobs older WHERE older.sender = candidate.sender AND older.sequence < candidate.sequence AND older.state IN ('ready','leased','sending'))`)
        .orderBy('candidate.available_at', 'asc').orderBy('candidate.sequence', 'asc').limit(1).executeTakeFirst();
      if (!row || !row.payload) return null;
      let payload: Record<string, unknown>;
      try { payload = decodeJobPayload(row.payload, key); }
      catch (error) {
        if (!(error instanceof WhatsAppPayloadDecryptionError)) throw error;
        const failed = await trx.updateTable('whatsapp_jobs').set({ state: 'failed', payload: null, fence: null, lease_expires_at: null, finished_at: time })
          .where('id', '=', row.id).where('state', '=', 'ready').returning('id').executeTakeFirst();
        quarantined = !!failed;
        return null;
      }
      const fence = randomUUID();
      const leased = await trx.updateTable('whatsapp_jobs').set({ state: 'leased', fence, attempts: sql<number>`attempts + 1`, lease_expires_at: time + LEASE_MS })
        .where('id', '=', row.id).where('state', '=', 'ready').where('expires_at', '>', time).returning('id').executeTakeFirst();
      if (!leased) return null;
      return { id: row.id, sender: row.sender, payload, fence, attempts: row.attempts + 1, expiresAt: row.expires_at };
    });
    if (quarantined) console.error('[whatsapp] Removed unreadable queued payload');
    return job;
  }
  async function checkpoint(id: string, fence: string, payload: Record<string, unknown>): Promise<boolean> {
    return transaction(async (trx) => {
      const row = await trx.updateTable('whatsapp_jobs').set({ payload: encryptWhatsAppPayload(payload, key), lease_expires_at: now() + LEASE_MS })
        .where('id', '=', id).where('fence', '=', fence).where('state', '=', 'leased').where('lease_expires_at', '>', now()).where('expires_at', '>', now())
        .returning('id').executeTakeFirst();
      return !!row;
    });
  }
  async function markSending(id: string, fence: string): Promise<boolean> {
    return transaction(async (trx) => {
      const row = await trx.updateTable('whatsapp_jobs').set({ state: 'sending', lease_expires_at: now() + LEASE_MS })
        .where('id', '=', id).where('fence', '=', fence).where('state', '=', 'leased').where('lease_expires_at', '>', now()).where('expires_at', '>', now())
        .returning('id').executeTakeFirst();
      return !!row;
    });
  }
  async function finish(id: string, fence: string, status: WhatsAppJobTerminalState): Promise<boolean> {
    if (!['complete', 'failed', 'unknown'].includes(status)) throw new WhatsAppRepositoryError('invalid_input');
    return transaction(async (trx) => {
      const row = await trx.updateTable('whatsapp_jobs').set({ state: status, payload: null, fence: null, lease_expires_at: null, finished_at: now() })
        .where('id', '=', id).where('fence', '=', fence).where('state', 'in', ['leased', 'sending'])
        .where('lease_expires_at', '>', now()).where('expires_at', '>', now()).returning('id').executeTakeFirst();
      return !!row;
    });
  }
  async function retry(id: string, fence: string, delayMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new WhatsAppRepositoryError('invalid_input');
    return transaction(async (trx) => {
      const row = await trx.updateTable('whatsapp_jobs').set({ state: 'ready', fence: null, lease_expires_at: null, available_at: now() + delayMs })
        .where('id', '=', id).where('fence', '=', fence).where('state', '=', 'leased')
        .where('lease_expires_at', '>', now()).where('expires_at', '>', now()).returning('id').executeTakeFirst();
      return !!row;
    });
  }
  async function cleanup(): Promise<void> {
    await transaction(async (trx) => {
      const time = now();
      await expireJobs(trx, time);
      await trx.deleteFrom('whatsapp_link_challenges').where('expires_at', '<=', time).execute();
      await trx.deleteFrom('whatsapp_jobs').where('state', 'not in', ACTIVE).where('created_at', '<', time - 7 * DAY_MS).execute();
    });
  }
  return { enqueue, lease, checkpoint, markSending, finish, retry, cleanup, getConnection, getConnectionBySender, disconnect, disconnectBySender, stop, startLink, claim, confirm, isChallengeActive, bindChat };
}
export type WhatsAppRepository = ReturnType<typeof createWhatsAppRepository>;
