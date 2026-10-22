import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { ChatRepository } from '../../packages/gateway/src/chat/repository.js';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { createOwnerChatHistoryRepository } from '../../packages/gateway/src/startup/chat-history.js';
import { bootstrapCollaborationDatabase } from '../../packages/gateway/src/collaboration/database.js';
import { createGoogleContextStore } from '../../packages/gateway/src/google-data/runtime/contexts.js';
import { createGoogleProvenanceStore } from '../../packages/gateway/src/google-data/provenance/store.js';
import { createGoogleContextAdmission } from '../../packages/gateway/src/startup/google-context-admission.js';

let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'] | undefined;
afterEach(async () => { await db?.destroy(); db = undefined; });
const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner-one', chatId: 'chat_one', runId: 'run_one', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64), route: { api: 'anthropic-messages', modelId: 'model-a', input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 }, accessSourceId: 'owner_anthropic_key', capabilities: ['artifact.read'], requestClass: 'interactive' };
async function admit(repo: ChatRepository, suffix = 'one', subject = { type: 'personal' as const, ownerId: 'owner-one' }) {
  const chatId = `chat_${suffix}`;
  const created = await repo.create(subject, { id: chatId, clientRequestId: `req_create_${suffix}`, title: 'Synthetic' });
  const at = new Date().toISOString();
  const message = { id: `msg_user_${suffix}`, chatId, seq: 1, role: 'user' as const, state: 'committed' as const,
    purpose: 'ai_request' as const, turnId: `cturn_${suffix}`, parts: [{ type: 'text' as const, text: 'preserve owner words' }], createdAt: at };
  const turn = { id: `cturn_${suffix}`, chatId, clientRequestId: `req_turn_${suffix}`, baseMessageSeq: 0,
    inputMessageId: message.id, status: 'accepted' as const, createdAt: at, updatedAt: at };
  const run = { id: `run_${suffix}`, chatId, turnId: turn.id, attempt: 1, driverKind: 'codex' as const,
    instanceId: 'codex_default', selection: { instanceId: 'codex_default', model: 'synthetic' },
    interactionMode: 'default' as const, permissionMode: 'supervised' as const, status: 'accepted' as const, historyBoundarySeq: 0,
    capabilitySnapshot: { revision: 'catalog_1', rootChat: true, attachments: ['file' as const], resources: ['file' as const],
      tools: ['read'], approvals: true, userInput: true, resume: true, cancellation: true, steering: 'same_run' as const,
      worktrees: 'optional' as const, interactionModes: ['default' as const], permissionModes: ['supervised' as const] }, createdAt: at, updatedAt: at };
  await repo.admitTurn(subject, { chatId, baseRevision: created.chat.revision, message, turn, run });
}

describe('owning context admission transaction', () => {
  it('adopts an ordinary run snapshot through real startup hooks before the first Google send and rejects tampering', async () => {
    ({ db } = await createAuthorityFixture()); const history = createOwnerChatHistoryRepository(db.sql, { pilot: { enabled: true, ownerId: binding.ownerId } });
    await history.bootstrap(); const repository = history.repository; await bootstrapCollaborationDatabase(repository.kysely as never);
    await admit(repository);
    // A normal server mutation persists an ordinary snapshot and its exact receipt.
    const details = (await repository.getDetailPage({ type: 'personal', ownerId: binding.ownerId }, binding.chatId, { limit: 20 }))!;
    await repository.finishRun({ type: 'personal', ownerId: binding.ownerId }, { chatId: binding.chatId, runId: binding.runId, outcome: 'completed', completedAt: new Date().toISOString() });
    const original = details.runs[0]!;
    const context = { version: 1 as const, requestHash: 'a'.repeat(64), chats: [{ chatId: binding.chatId, title: 'Synthetic', throughSeq: 1, text: 'synthetic context', truncated: false }] };
    await repository.admitRetry({ type: 'personal', ownerId: binding.ownerId }, { chatId: binding.chatId, turnId: original.turnId, clientRequestId: 'req_retry_one', baseRevision: (await repository.get({ type: 'personal', ownerId: binding.ownerId }, binding.chatId))!.chat.revision, run: { ...original, id: 'run_retry', attempt: 2, context } });
    const registry = new BotRuntimeRegistry(); const retry = { ...binding, runId: 'run_retry' }; registry.bind(retry);
    const admission = createGoogleContextAdmission({ registry, repository, adapter: history.googleCopies!.context });
    const contexts = createGoogleContextStore(repository.kysely); const deadline = new Date(Date.now() + 60000).toISOString();
    await contexts.mark({ ownerId: binding.ownerId, chatId: binding.chatId, googleAccountId: '123e4567-e89b-42d3-a456-426614174000', consentId: 'consent_one', profileId: 'profile_one', profileRevision: 1, purposeId: 'assistant', expiresAt: deadline, retentionDeadline: deadline });
    await admission(retry, new AbortController().signal);
    const store = createGoogleProvenanceStore(repository.kysely); expect(await store.inspect(binding.ownerId, 'derived', 'grc_run_retry')).toMatchObject({ state: 'active', revision: 1 });
    await sql`UPDATE chat_runs SET context_snapshot=jsonb_set(context_snapshot,'{chats,0,text}','"modified"') WHERE id='run_retry'`.execute(repository.kysely);
    await expect(admission(retry, new AbortController().signal)).rejects.toThrow(); registry.shutdown();
  });

  it('forwards synchronous release checks to the owning commit ledger and preserves rollback', async () => {
    ({ db } = await createAuthorityFixture()); const repository = new ChatRepository(db.sql); await repository.bootstrap();
    const check = vi.fn((): true => { throw new Error('expired after commit'); });
    await expect(repository.withContextTransaction(async tx => { await sql`CREATE TABLE admission_commit_probe(id integer)`.execute(tx); }, check)).rejects.toThrow('expired after commit');
    expect(check).toHaveBeenCalledOnce();
    expect((await sql`SELECT * FROM admission_commit_probe`.execute(repository.kysely)).rows).toEqual([]);
    const refused = vi.fn((): true => { throw new Error('expired before commit'); });
    await expect(repository.withContextTransaction(async tx => { await sql`INSERT INTO admission_commit_probe VALUES (1)`.execute(tx); throw new Error('rollback'); }, refused)).rejects.toThrow('rollback');
    expect(refused).not.toHaveBeenCalled();
    expect((await sql`SELECT * FROM admission_commit_probe`.execute(repository.kysely)).rows).toEqual([]);
  });
  it('adopts only the exact live run and forwards the owning transaction and request cancellation', async () => {
    const registry = new BotRuntimeRegistry(); registry.bind(binding); const signal = new AbortController();
    const transact = vi.fn(); const write = vi.fn(async (_key, actualTransact, _content, actualSignal) => { expect(actualTransact).toBe(transact); expect(actualSignal.aborted).toBe(false); });
    const admit = createGoogleContextAdmission({ registry, repository: { withContextTransaction: transact }, adapter: { write } });
    await admit(binding, signal.signal);
    expect(write.mock.calls[0]?.[0]).toEqual({ owner: { type: 'personal', ownerId: binding.ownerId }, chatId: binding.chatId, runIds: [binding.runId] });
    registry.cancelInference(binding);
    await expect(admit(binding, signal.signal)).rejects.toThrow('Google data processing unavailable'); expect(write).toHaveBeenCalledTimes(1); registry.shutdown();
  });
  it('refuses a generation revoked while the actual context adoption waits', async () => {
    const registry = new BotRuntimeRegistry(); registry.bind(binding);
    const write = vi.fn(async () => { registry.cancelInference(binding); });
    const admit = createGoogleContextAdmission({ registry, repository: { withContextTransaction: vi.fn() }, adapter: { write } });
    await expect(admit(binding, new AbortController().signal)).rejects.toThrow('Google data processing unavailable'); registry.shutdown();
  });
});
