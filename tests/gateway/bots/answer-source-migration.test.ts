import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { bootstrapBotDatabase, BotSchemaError } from '../../../packages/gateway/src/bots/database.js';
import { BOT_MIGRATIONS } from '../../../packages/gateway/src/bots/database-migrations.js';
import { BOT, OWNER, NOW, createBotStateDatabase, insertChat } from './bot-state-support.js';
import { createBotTasksRepository } from '../../../packages/gateway/src/bots/repositories/tasks.js';
import { createBotInteractionsRepository } from '../../../packages/gateway/src/bots/repositories/interactions.js';

it('upgrades an existing question without inventing its source, and keeps repeat startup idempotent', async () => {
  const { db, destroy } = await createBotStateDatabase({ migrate: false });
  try {
    await bootstrapBotDatabase(db, BOT_MIGRATIONS.slice(0, 8));
    await insertChat(db, 'chat_source_upgrade');
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: 'chat_source_upgrade', now: NOW });
    const questions = createBotInteractionsRepository(db);
    const interaction = { interactionId: 'in_source_legacy', payload: { kind: 'question', questions: [] } };
    // Literal deployed-v8 insert: the new repository is intentionally used
    // only after bootstrap, just as gateway startup requires.
    await sql`INSERT INTO bot_interactions (interaction_id, owner_id, bot_id, chat_id, task_id, kind,
      payload, responder_actor_id, blocking, status, resolution, expires_at, created_at, resolved_at)
      VALUES (${interaction.interactionId}, ${OWNER}, ${BOT}, 'chat_source_upgrade', ${task.taskId}, 'question',
      ${JSON.stringify(interaction.payload)}::jsonb, ${OWNER}, true, 'pending', NULL,
      '2026-09-28T12:00:00.000Z', ${NOW}, NULL)`.execute(db);
    expect((await bootstrapBotDatabase(db)).applied).toEqual([9,10,11]);
    const stored = await sql<{ source_run_id: string | null; resolution: unknown; status: string }>`SELECT source_run_id, resolution, status FROM bot_interactions WHERE interaction_id=${interaction.interactionId}`.execute(db);
    expect(stored.rows).toEqual([{ source_run_id: null, resolution: null, status: 'pending' }]);
    await expect(sql`UPDATE bot_interactions SET source_run_id='invalid-source' WHERE interaction_id=${interaction.interactionId}`.execute(db)).rejects.toThrow();
    expect((await questions.get({ ownerId: OWNER, interactionId: interaction.interactionId }))?.payload).toEqual(interaction.payload);
    expect((await bootstrapBotDatabase(db)).applied).toEqual([]);
    await expect(bootstrapBotDatabase(db, BOT_MIGRATIONS.slice(0, 8))).rejects.toEqual(new BotSchemaError('newer_schema'));
  } finally { await destroy(); }
});
