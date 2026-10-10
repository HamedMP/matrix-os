import { createHash, randomBytes } from 'node:crypto';
import type { PlatformDB, PreviewDriveGrantsTable } from './db.js';

const RUN_TTL_MS = 35 * 60_000;
const ACTION_TTL_MS = 90_000;
const TOKEN = /^[a-f0-9]{64}$/;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonceDigest(kind: 'run' | 'action', nonce: string): string {
  return digest(`matrix-preview-drive-${kind}:v1\0${nonce}`);
}

export interface PreviewDriveRun {
  actorId: string;
  handle: string;
  chatId: string;
  turnId: string;
  runId: string;
  clientRequestId: string;
  bodyDigest: string;
}

type RunLookup = { token: string; handle: string; chatId: string; runId: string };

/** Durable hashed tokens; no Cloud Run instance owns authorization state. */
export function createPreviewDriveStore(db: PlatformDB, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;

  async function readRun(input: RunLookup, executor = db.executor, lock = false): Promise<PreviewDriveRun | null> {
    if (!TOKEN.test(input.token)) return null;
    let query = executor.selectFrom('preview_drive_grants')
      .selectAll()
      .where('token_hash', '=', digest(input.token))
      .where('kind', '=', 'run')
      .where('handle', '=', input.handle)
      .where('chat_id', '=', input.chatId)
      .where('run_id', '=', input.runId)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', new Date(now()).toISOString());
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    // A lock wait may outlive the lease even though the query's timestamp
    // predicate was valid when issued. Recheck before admitting any work.
    return row && row.expires_at > new Date(now()).toISOString() ? {
      actorId: row.actor_id, handle: row.handle, chatId: row.chat_id,
      turnId: row.turn_id, runId: row.run_id,
      clientRequestId: row.client_request_id, bodyDigest: row.body_digest,
    } : null;
  }

  async function withRun<T>(input: RunLookup, work: (run: PreviewDriveRun) => Promise<T>): Promise<T | null> {
    return db.transaction(async trx => {
      const run = await readRun(input, trx.executor, true);
      return run ? work(run) : null;
    });
  }
  const getRun = (input: RunLookup) => readRun(input);
  const bindingValid = (value: unknown): value is string => typeof value === 'string'
    && value.length > 0 && value.length <= 256 && value === value.trim();

  return {
    async redeemTurn(input: PreviewDriveRun & { proofNonce: string }): Promise<string | null> {
      if (!/^[a-f0-9]{32}$/.test(input.proofNonce)) return null;
      const token = randomBytes(32).toString('hex');
      const inserted = await db.executor.insertInto('preview_drive_grants').values({
        token_hash: digest(token), kind: 'run', proof_nonce_hash: nonceDigest('run', input.proofNonce),
        run_token_hash: null, handle: input.handle, actor_id: input.actorId,
        chat_id: input.chatId, turn_id: input.turnId, run_id: input.runId,
        client_request_id: input.clientRequestId, body_digest: input.bodyDigest,
        action_digest: null, account_label: null, connection_id: null, provider_account_id: null, max_results: null,
        expires_at: new Date(now() + RUN_TTL_MS).toISOString(), consumed_at: null,
      }).onConflict(oc => oc.doNothing()).returning('token_hash').executeTakeFirst();
      return inserted ? token : null;
    },
    getRun,
    withRun,
    async issueAction(input: { runGrant: string; proofNonce: string; proofExpiresAt: number; handle: string; actorId: string;
      chatId: string; runId: string; actionDigest: string; label: string; maxResults: number; connectionId: string; providerAccountId: string }): Promise<string | null> {
      if (!TOKEN.test(input.runGrant) || !/^[a-f0-9]{32}$/.test(input.proofNonce)
        || !bindingValid(input.connectionId) || !bindingValid(input.providerAccountId)) return null;
      return withRun({ token: input.runGrant, handle: input.handle, chatId: input.chatId, runId: input.runId }, async run => {
        // Signed browser approval must remain live after run-row lock waits and
        // any preceding connection lookup; admission cannot extend its TTL.
        if (run.actorId !== input.actorId || !Number.isSafeInteger(input.proofExpiresAt)
          || input.proofExpiresAt <= now()) return null;
        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date(now() + ACTION_TTL_MS).toISOString();
        const row: PreviewDriveGrantsTable = {
          token_hash: digest(token), kind: 'action', proof_nonce_hash: nonceDigest('action', input.proofNonce),
          run_token_hash: digest(input.runGrant), handle: run.handle, actor_id: run.actorId,
          chat_id: run.chatId, turn_id: run.turnId, run_id: run.runId,
          client_request_id: run.clientRequestId, body_digest: run.bodyDigest,
          action_digest: input.actionDigest, account_label: input.label, max_results: input.maxResults,
          connection_id: input.connectionId, provider_account_id: input.providerAccountId,
          expires_at: expiresAt, consumed_at: null,
        };
        const inserted = await db.executor.insertInto('preview_drive_grants').values(row)
          .onConflict(oc => oc.doNothing()).returning('token_hash').executeTakeFirst();
        return inserted ? token : null;
      });
    },
    async consumeAction(input: { runGrant: string; grant: string; handle: string; chatId: string;
      runId: string; actionDigest: string; label: string; maxResults: number }): Promise<{ actorId: string; connectionId: string; providerAccountId: string } | null> {
      if (!TOKEN.test(input.runGrant) || !TOKEN.test(input.grant)) return null;
      return withRun({ token: input.runGrant, handle: input.handle, chatId: input.chatId, runId: input.runId }, async run => {
        const row = await db.executor.updateTable('preview_drive_grants')
          .set({ consumed_at: new Date(now()).toISOString() })
          .where('token_hash', '=', digest(input.grant))
          .where('kind', '=', 'action')
          .where('run_token_hash', '=', digest(input.runGrant))
          .where('handle', '=', input.handle)
          .where('chat_id', '=', input.chatId)
          .where('run_id', '=', input.runId)
          .where('actor_id', '=', run.actorId)
          .where('action_digest', '=', input.actionDigest)
          .where('account_label', '=', input.label)
          .where('max_results', '=', input.maxResults)
          .where('expires_at', '>', new Date(now()).toISOString())
          .where('consumed_at', 'is', null)
          .where('connection_id', 'is not', null)
          .where('provider_account_id', 'is not', null)
          .returning(['actor_id', 'connection_id', 'provider_account_id']).executeTakeFirst();
        return row && bindingValid(row.connection_id) && bindingValid(row.provider_account_id)
          ? { actorId: row.actor_id, connectionId: row.connection_id, providerAccountId: row.provider_account_id } : null;
      });
    },
    async sweep(): Promise<number> {
      const deleted = await db.executor.deleteFrom('preview_drive_grants')
        .where('expires_at', '<=', new Date(now()).toISOString())
        .returning('token_hash').execute();
      return deleted.length;
    },
    async revokeRun(input: RunLookup): Promise<number> {
      if (!TOKEN.test(input.token)) return 0;
      return await withRun(input, async () => {
        const runHash = digest(input.token);
        // Retain nonce uniqueness until expiry; deleting revocations makes a
        // still-valid signed browser proof redeemable again.
        const revoked = await db.executor.updateTable('preview_drive_grants')
          .set({ consumed_at: new Date(now()).toISOString() })
          .where('handle', '=', input.handle)
          .where('chat_id', '=', input.chatId)
          .where('run_id', '=', input.runId)
          .where('consumed_at', 'is', null)
          .where(eb => eb.or([
            eb('token_hash', '=', runHash),
            eb('run_token_hash', '=', runHash),
          ]))
          .returning('token_hash').execute();
        return revoked.length;
      }) ?? 0;
    },
  };
}
