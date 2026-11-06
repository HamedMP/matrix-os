import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { beginBotTask } from '../../../packages/gateway/src/bots/task-begin.js';
import { createBotInteractionService, BotInteractionError } from '../../../packages/gateway/src/bots/interactions.js';
import { createBotStateTransactions } from '../../../packages/gateway/src/bots/events.js';
import { createBotTasksRepository } from '../../../packages/gateway/src/bots/repositories/tasks.js';
import { createBotBindingsRepository } from '../../../packages/gateway/src/bots/repositories/bindings.js';
import type { OwnerBotDatabase } from '../../../packages/gateway/src/bots/database.js';
import type { ChatDatabase } from '../../../packages/gateway/src/chat/database.js';
import { ChatRepository } from '../../../packages/gateway/src/chat/repository.js';
import type { BotRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
import { BOT, OWNER, OTHER_OWNER, createBotStateDatabase, insertChat } from './bot-state-support.js';

const CHAT = 'chat_recover_answer';
let db: Kysely<OwnerBotDatabase>, destroy: () => Promise<void>;
let clock: number, taskId: string, interactionId: string;
const makeService = () => createBotInteractionService({ transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)), now: () => new Date(clock) });
beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  clock = Date.parse('2026-10-26T00:00:00Z');
  const now = new Date(clock).toISOString();
  await insertChat(db, CHAT);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now });
  const tasks = createBotTasksRepository(db);
  const created = await tasks.create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now });
  const running = await tasks.transition({ ownerId: OWNER, taskId: created.taskId, baseRevision: created.revision, to: 'running', runId: 'run_ask', now });
  taskId = running.taskId;
  await tasks.transition({ ownerId: OWNER, taskId, baseRevision: running.revision, to: 'waiting_person', now });
  await makeService().createFromTool({ ownerId: OWNER, botId: BOT, chatId: CHAT, taskId, capabilities: ['interaction.create'] } as BotRuntimeBinding, {
    blocking: true, payload: { kind: 'question', questions: [{ questionId: 'tone', header: 'Tone', question: 'Which tone?', allowOther: true, secret: false }] },
  });
  const [question] = await makeService().listPending(OWNER, CHAT, { includeRecovery: true });
  interactionId = question!.interactionId;
  // Save is real; no continuation admission is performed, matching its failure boundary.
  await makeService().resolve(OWNER, CHAT, interactionId, { kind: 'question', baseRevision: 1, answer: 'Concise' });
});
afterEach(async () => { await destroy(); });

it('keeps a committed answer discoverable across a new service/read without revealing the answer', async () => {
  const pending = await makeService().listPending(OWNER, CHAT, { includeRecovery: true });
  expect(pending).toEqual([expect.objectContaining({ interactionId, status: 'resolved', recoveryAvailable: true, revision: 2 })]);
  expect(JSON.stringify(pending)).not.toContain('Concise');
  expect(await makeService().listPending(OTHER_OWNER, CHAT)).toEqual([]);
});

it('resumes only the saved answer under its original deterministic admission identity', async () => {
  const first = await makeService().resolve(OWNER, CHAT, interactionId, { kind: 'resume', baseRevision: 2 });
  expect(first.continuation).toEqual({ chatId: CHAT, clientRequestId: `req_answer_${interactionId}`, text: 'Concise' });
  expect(await makeService().resolve(OWNER, CHAT, interactionId, { kind: 'resume', baseRevision: 2 })).toEqual(first);
  await expect(makeService().resolve(OTHER_OWNER, CHAT, interactionId, { kind: 'resume', baseRevision: 2 })).rejects.toEqual(new BotInteractionError('not_found'));
});

it('does not expose or resume an expired committed answer', async () => {
  clock += 24 * 60 * 60 * 1000;
  expect(await makeService().listPending(OWNER, CHAT, { includeRecovery: true })).toEqual([]);
  await expect(makeService().resolve(OWNER, CHAT, interactionId, { kind: 'resume', baseRevision: 2 })).rejects.toEqual(new BotInteractionError('expired'));
});

it('does not resurrect a cancelled waiting task', async () => {
  const tasks = createBotTasksRepository(db), task = (await tasks.get({ ownerId: OWNER, taskId }))!;
  await tasks.transition({ ownerId: OWNER, taskId, baseRevision: task.revision, to: 'cancelled', now: new Date(clock).toISOString() });
  expect(await makeService().listPending(OWNER, CHAT, { includeRecovery: true })).toEqual([]);
  await expect(makeService().resolve(OWNER, CHAT, interactionId, { kind: 'resume', baseRevision: 2 })).rejects.toEqual(new BotInteractionError('conflict'));
});

async function recordCanonicalAnswer() {
  const at = new Date(clock).toISOString(), requestId = `req_answer_${interactionId}`;
  await db.insertInto('chat_messages').values({ id: 'msg_answer', chat_id: CHAT, seq: 1, role: 'user', purpose: 'ai_request', state: 'committed', turn_id: null, run_id: null, actor_id: OWNER, parts: JSON.stringify([{ type: 'text', text: 'Concise' }]), byte_count: 7, search_text: 'Concise', created_at: at }).execute();
  await db.insertInto('chat_turns').values({ id: 'cturn_answer', chat_id: CHAT, client_request_id: requestId, base_message_seq: 0, input_message_id: 'msg_answer', status: 'accepted', created_at: at, updated_at: at }).execute();
  await db.insertInto('chat_runs').values({ id: 'run_answer', chat_id: CHAT, turn_id: 'cturn_answer', client_request_id: requestId, attempt: 1, request_hash: '9b1d3e71b4e50f1f3260b410669f959cae3cb471e40066992a21f77a28bbd63e', driver_kind: 'matrix_bot', instance_id: 'matrix_bot_default', selection: JSON.stringify({ instanceId: 'matrix_bot_default', model: 'auto' }), interaction_mode: 'default', permission_mode: 'default', execution_root: null, execution_root_fingerprint: null, status: 'accepted', outcome: null, started_at: null, completed_at: null, history_boundary_seq: 0, capability_snapshot: JSON.stringify({}), created_at: at, updated_at: at }).execute();
}

const beginRecordedAnswer = (text = 'Concise') => createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>))(OWNER,
  tx => beginBotTask(tx, { ownerId: OWNER, botId: BOT, chatId: CHAT, runId: 'run_answer', text, now: new Date(clock).toISOString() }));

it('rechecks cancellation at dispatch so a late canonical answer never creates a new task', async () => {
  const tasks = createBotTasksRepository(db), task = (await tasks.get({ ownerId: OWNER, taskId }))!;
  await tasks.transition({ ownerId: OWNER, taskId, baseRevision: task.revision, to: 'cancelled', now: new Date(clock).toISOString() });
  await recordCanonicalAnswer();
  await expect(beginRecordedAnswer()).rejects.toBeDefined();
  const rows = await db.selectFrom('bot_tasks').selectAll().execute();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('cancelled');
});

it('dispatches a saved answer only into its original waiting task and rejects substituted text', async () => {
  await recordCanonicalAnswer();
  await expect(beginRecordedAnswer('Changed answer')).rejects.toBeDefined();
  const started = await beginRecordedAnswer();
  expect(started.continued).toBe(true);
  expect(started.task.taskId).toBe(taskId);
  expect(started.task.runId).toBe('run_answer');
  expect(await makeService().listPending(OWNER, CHAT, { includeRecovery: true })).toEqual([]);
});

it('refuses an answer that expired while queued before dispatch', async () => {
  await recordCanonicalAnswer();
  clock += 24 * 60 * 60 * 1000;
  await expect(beginRecordedAnswer()).rejects.toBeDefined();
  expect((await createBotTasksRepository(db).get({ ownerId: OWNER, taskId }))?.status).toBe('waiting_person');
});

it('does not replay the original saved submission after its deadline', async () => {
  clock += 24 * 60 * 60 * 1000;
  await expect(makeService().resolve(OWNER, CHAT, interactionId, { kind: 'question', baseRevision: 1, answer: 'Concise' })).rejects.toEqual(new BotInteractionError('expired'));
});

it('confirms an already-admitted recovery without offering another continuation', async () => {
  await recordCanonicalAnswer();
  expect(await makeService().resolve(OWNER, CHAT, interactionId, { kind: 'resume', baseRevision: 2 })).toEqual({
    response: { interaction: { interactionId, status: 'resolved', revision: 2 } },
  });
});

it('does not confirm a different payload using the same reserved request ID', async () => {
  await recordCanonicalAnswer();
  await db.updateTable('chat_runs').set({ request_hash: 'f'.repeat(64) }).where('id', '=', 'run_answer').execute();
  await expect(makeService().resolve(OWNER, CHAT, interactionId, { kind: 'resume', baseRevision: 2 })).rejects.toEqual(new BotInteractionError('conflict'));
});

it('keeps legacy pending-only reads free of newly introduced resolved recovery fields', async () => {
  expect(await makeService().listPending(OWNER, CHAT)).toEqual([]);
});

it('fails closed when the direct bot binding was removed after saving the answer', async () => {
  await db.updateTable('bot_chat_bindings').set({ removed_at: new Date(clock).toISOString() })
    .where('owner_id', '=', OWNER).where('chat_id', '=', CHAT).execute();
  expect(await makeService().listPending(OWNER, CHAT, { includeRecovery: true })).toEqual([]);
  await expect(makeService().resolve(OWNER, CHAT, interactionId, { kind: 'resume', baseRevision: 2 }))
    .rejects.toEqual(new BotInteractionError('conflict'));
});

it('never offers an earlier saved answer after the task reaches a later question', async () => {
  const tasks = createBotTasksRepository(db), previous = (await tasks.get({ ownerId: OWNER, taskId }))!;
  const running = await tasks.transition({ ownerId: OWNER, taskId, baseRevision: previous.revision,
    to: 'running', runId: 'run_later', now: new Date(clock).toISOString() });
  await makeService().createFromTool({ ownerId: OWNER, botId: BOT, chatId: CHAT, taskId,
    capabilities: ['interaction.create'] } as BotRuntimeBinding, {
    blocking: true, payload: { kind: 'question', questions: [{ questionId: 'recipient', header: 'Recipient',
      question: 'Which recipient?', allowOther: true, secret: false }] },
  });
  await tasks.transition({ ownerId: OWNER, taskId, baseRevision: running.revision,
    to: 'waiting_person', now: new Date(clock).toISOString() });
  const visible = await makeService().listPending(OWNER, CHAT, { includeRecovery: true });
  expect(visible.map(item => item.interactionId)).not.toContain(interactionId);
  expect(visible).toHaveLength(1);
  await expect(makeService().resolve(OWNER, CHAT, interactionId, { kind: 'resume', baseRevision: 2 }))
    .rejects.toEqual(new BotInteractionError('conflict'));
  // An original button resubmission must not replay the stale intent either.
  await expect(makeService().resolve(OWNER, CHAT, interactionId, { kind: 'question', baseRevision: 1, answer: 'Concise' }))
    .rejects.toEqual(new BotInteractionError('conflict'));
  await recordCanonicalAnswer();
  await expect(beginRecordedAnswer()).rejects.toBeDefined();
  expect((await tasks.get({ ownerId: OWNER, taskId }))?.status).toBe('waiting_person');
});

it('preserves an answer saved while the original asking run is still settling', async () => {
  const tasks = createBotTasksRepository(db), previous = (await tasks.get({ ownerId: OWNER, taskId }))!;
  const running = await tasks.transition({ ownerId: OWNER, taskId, baseRevision: previous.revision,
    to: 'running', runId: 'run_early_ask', now: new Date(clock).toISOString() });
  await makeService().createFromTool({ ownerId: OWNER, botId: BOT, chatId: CHAT, taskId,
    runId: 'run_early_ask', capabilities: ['interaction.create'] } as BotRuntimeBinding, {
    blocking: true, payload: { kind: 'question', questions: [{ questionId: 'early', header: 'Early',
      question: 'Reply while this run settles?', allowOther: true, secret: false }] },
  });
  const [next] = await makeService().listPending(OWNER, CHAT);
  interactionId = next!.interactionId;
  expect((await makeService().resolve(OWNER, CHAT, interactionId, { kind: 'question', baseRevision: 1,
    answer: 'Concise' })).continuation?.text).toBe('Concise');
  await tasks.transition({ ownerId: OWNER, taskId, baseRevision: running.revision,
    to: 'waiting_person', now: new Date(clock).toISOString() });
  expect(await makeService().listPending(OWNER, CHAT, { includeRecovery: true })).toEqual([
    expect.objectContaining({ interactionId, recoveryAvailable: true }),
  ]);
  await recordCanonicalAnswer();
  expect((await beginRecordedAnswer()).task.taskId).toBe(taskId);
});

it('does not guess the source of a legacy pending question while a run is busy', async () => {
  const tasks = createBotTasksRepository(db), previous = (await tasks.get({ ownerId: OWNER, taskId }))!;
  await tasks.transition({ ownerId: OWNER, taskId, baseRevision: previous.revision,
    to: 'running', runId: 'run_busy_legacy', now: new Date(clock).toISOString() });
  await makeService().createFromTool({ ownerId: OWNER, botId: BOT, chatId: CHAT, taskId,
    capabilities: ['interaction.create'] } as BotRuntimeBinding, {
    blocking: true, payload: { kind: 'question', questions: [{ questionId: 'legacy', header: 'Legacy',
      question: 'Legacy source unknown?', allowOther: true, secret: false }] },
  });
  const [question] = await makeService().listPending(OWNER, CHAT);
  await expect(makeService().resolve(OWNER, CHAT, question!.interactionId,
    { kind: 'question', baseRevision: 1, answer: 'Do not bind this to another run.' }))
    .rejects.toEqual(new BotInteractionError('conflict'));
});
