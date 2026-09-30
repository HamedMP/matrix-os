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

  async function getRun(input: RunLookup): Promise<PreviewDriveRun | null> {
    if (!TOKEN.test(input.token)) return null;
    const row = await db.kysely.selectFrom('preview_drive_grants')
      .selectAll()
      .where('token_hash', '=', digest(input.token))
      .where('kind', '=', 'run')
      .where('handle', '=', input.handle)
      .where('chat_id', '=', input.chatId)
      .where('run_id', '=', input.runId)
      .where('expires_at', '>', new Date(now()).toISOString())
      .executeTakeFirst();
    return row ? {
      actorId: row.actor_id, handle: row.handle, chatId: row.chat_id,
      turnId: row.turn_id, runId: row.run_id,
      clientRequestId: row.client_request_id, bodyDigest: row.body_digest,
    } : null;
  }

  return {
    async redeemTurn(input: PreviewDriveRun & { proofNonce: string }): Promise<string | null> {
      if (!/^[a-f0-9]{32}$/.test(input.proofNonce)) return null;
      const token = randomBytes(32).toString('hex');
      const inserted = await db.kysely.insertInto('preview_drive_grants').values({
        token_hash: digest(token), kind: 'run', proof_nonce_hash: nonceDigest('run', input.proofNonce),
        run_token_hash: null, handle: input.handle, actor_id: input.actorId,
        chat_id: input.chatId, turn_id: input.turnId, run_id: input.runId,
        client_request_id: input.clientRequestId, body_digest: input.bodyDigest,
        action_digest: null, account_label: null, max_results: null,
        expires_at: new Date(now() + RUN_TTL_MS).toISOString(), consumed_at: null,
      }).onConflict(oc => oc.doNothing()).returning('token_hash').executeTakeFirst();
      return inserted ? token : null;
    },
    getRun,
    async issueAction(input: { runGrant: string; proofNonce: string; handle: string; actorId: string;
      chatId: string; runId: string; actionDigest: string; label: string; maxResults: number }): Promise<string | null> {
      if (!TOKEN.test(input.runGrant) || !/^[a-f0-9]{32}$/.test(input.proofNonce)) return null;
      const run = await getRun({ token: input.runGrant, handle: input.handle, chatId: input.chatId, runId: input.runId });
      if (!run || run.actorId !== input.actorId) return null;
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(now() + ACTION_TTL_MS).toISOString();
      const row: PreviewDriveGrantsTable = {
        token_hash: digest(token), kind: 'action', proof_nonce_hash: nonceDigest('action', input.proofNonce),
        run_token_hash: digest(input.runGrant), handle: run.handle, actor_id: run.actorId,
        chat_id: run.chatId, turn_id: run.turnId, run_id: run.runId,
        client_request_id: run.clientRequestId, body_digest: run.bodyDigest,
        action_digest: input.actionDigest, account_label: input.label, max_results: input.maxResults,
        expires_at: expiresAt, consumed_at: null,
      };
      const inserted = await db.kysely.insertInto('preview_drive_grants').values(row)
        .onConflict(oc => oc.doNothing()).returning('token_hash').executeTakeFirst();
      return inserted ? token : null;
    },
    async consumeAction(input: { runGrant: string; grant: string; handle: string; chatId: string;
      runId: string; actionDigest: string; label: string; maxResults: number }): Promise<{ actorId: string } | null> {
      if (!TOKEN.test(input.runGrant) || !TOKEN.test(input.grant)) return null;
      const run = await getRun({ token: input.runGrant, handle: input.handle, chatId: input.chatId, runId: input.runId });
      if (!run) return null;
      const row = await db.kysely.updateTable('preview_drive_grants')
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
        .returning('actor_id').executeTakeFirst();
      return row ? { actorId: row.actor_id } : null;
    },
    async sweep(): Promise<number> {
      const deleted = await db.kysely.deleteFrom('preview_drive_grants')
        .where('expires_at', '<=', new Date(now()).toISOString())
        .returning('token_hash').execute();
      return deleted.length;
    },
    async revokeRun(input: RunLookup): Promise<number> {
      if (!TOKEN.test(input.token)) return 0;
      const runHash = digest(input.token);
      const deleted = await db.kysely.deleteFrom('preview_drive_grants')
        .where('handle', '=', input.handle)
        .where('chat_id', '=', input.chatId)
        .where('run_id', '=', input.runId)
        .where(eb => eb.or([
          eb('token_hash', '=', runHash),
          eb('run_token_hash', '=', runHash),
        ]))
        .returning('token_hash').execute();
      return deleted.length;
    },
  };
}
