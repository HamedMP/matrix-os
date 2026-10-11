import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapChatDatabase } from '../../packages/gateway/src/chat/database.js';
import { bootstrapCollaborationDatabase } from '../../packages/gateway/src/collaboration/database.js';
import { CollaborationRepository } from '../../packages/gateway/src/collaboration/repository.js';
import { bootstrapBotDatabase } from '../../packages/gateway/src/bots/database.js';
import { createBotMemoryRepository } from '../../packages/gateway/src/bots/repositories/memory.js';

const fixtures: Array<{ destroy(): Promise<void> }> = [];
beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.destroy();
});
async function collaboration() {
  const { createCollaborationTestDatabase } = await import('../gateway/collaboration-test-support.js');
  const fixture = await createCollaborationTestDatabase();
  fixtures.push(fixture);
  return fixture;
}
async function bots(options?: { migrate?: boolean }) {
  const { createBotStateDatabase } = await import('../gateway/bots/bot-state-support.js');
  const fixture = await createBotStateDatabase(options);
  fixtures.push(fixture);
  return fixture;
}

describe('shared bot and collaboration empty database fixtures', () => {
  it('reuses one closed empty template across helpers and closes every independent clone through unchanged teardown', async () => {
    const { KyselyPGlite } = await import('kysely-pglite');
    const original = KyselyPGlite.create.bind(KyselyPGlite);
    const initialSchemas: unknown[][] = [];
    const create = vi.spyOn(KyselyPGlite, 'create').mockImplementation(async (...args) => {
      const engine = await original(...args);
      initialSchemas.push((await engine.client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows);
      return engine;
    });
    const [first, second] = await Promise.all([collaboration(), bots({ migrate: false })]);
    expect(create).toHaveBeenCalledTimes(3);
    expect(initialSchemas).toEqual([[], [], []]);
    const engines = await Promise.all(create.mock.results.map(result => result.value));
    expect(engines[0].client.closed).toBe(true);
    expect(engines[1].client).not.toBe(engines[2].client);
    const options = create.mock.calls.slice(1).map(args => args[0] as unknown as { loadDataDir: Blob });
    expect(options[0].loadDataDir).toBeInstanceOf(Blob);
    expect(options[1].loadDataDir).toBe(options[0].loadDataDir);
    expect((await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`.execute(first.db)).rows).toEqual([]);
    await first.destroy();
    await second.destroy();
    fixtures.splice(0);
    expect(engines.every(engine => engine.client.closed)).toBe(true);
  });

  it('preserves migrate:false Chat startup while leaving all Bot migrations for the caller', async () => {
    const { db } = await bots({ migrate: false });
    expect((await sql`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'bot_%' AND table_schema = 'public'`.execute(db)).rows).toEqual([]);
    expect((await sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'chats' AND table_schema = 'public'`.execute(db)).rows)
      .toEqual([{ table_name: 'chats' }]);
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [1, 2, 3, 4, 5, 6, 7] });
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [] });
    const next = await bots({ migrate: false });
    expect((await sql`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'bot_%' AND table_schema = 'public'`.execute(next.db)).rows).toEqual([]);
  });

  it('keeps collaboration app schema, authority rows, and audit sequences independent between concurrent fixtures', async () => {
    const [first, second] = await Promise.all([collaboration(), collaboration()]);
    for (const fixture of [first, second]) {
      expect((await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`.execute(fixture.db)).rows).toEqual([]);
      await bootstrapChatDatabase(fixture.db);
      await bootstrapCollaborationDatabase(fixture.db);
    }
    const input = {
      scopeId: '10000000-0000-4000-8000-000000000001', organizationId: 'org_snapshot',
      ownerId: 'user_snapshot_owner', kind: 'chat' as const, resourceId: 'chat_snapshot',
      authorityRuntimeId: 'runtime_snapshot',
    };
    await new CollaborationRepository(first.db).createDirectScope(input);
    expect(await second.db.selectFrom('collaboration_scopes').selectAll().execute()).toEqual([]);
    await new CollaborationRepository(second.db).createDirectScope(input);
    await first.db.updateTable('collaboration_scopes').set({ revision: 10 }).where('id', '=', input.scopeId).execute();
    expect(await second.db.selectFrom('collaboration_scopes').select('revision').execute()).toEqual([{ revision: 0 }]);
    const nextSequence = async (fixture: typeof first) =>
      (await sql<{ value: number }>`SELECT nextval(pg_get_serial_sequence('collaboration_audit', 'id'))::int AS value`.execute(fixture.db)).rows[0].value;
    const firstNext = await nextSequence(first);
    expect(await nextSequence(first)).toBe(firstNext + 1);
    expect(await nextSequence(second)).toBe(firstNext);
    expect((await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`.execute((await collaboration()).db)).rows).toEqual([]);
  });

  it('keeps migrated bot data, chat sequences, and subsequent baseline defaults independent', async () => {
    const [first, second] = await Promise.all([bots(), bots()]);
    const base = { ownerId: 'user_snapshot_owner', botId: 'bot_0123456789abcdef', kind: 'fact' as const,
      scope: 'bot', source: {}, confirmed: true, now: '2026-09-27T12:00:00.000Z' };
    await createBotMemoryRepository(first.db).remember({ ...base, content: 'Only the first database knows this' });
    expect(await second.db.selectFrom('bot_memory_items').selectAll().execute()).toEqual([]);
    await createBotMemoryRepository(second.db).remember({ ...base, content: 'Only the second database knows this' });
    expect(await first.db.selectFrom('bot_memory_items').select('content').execute())
      .toEqual([{ content: 'Only the first database knows this' }]);
    const nextSequence = async (fixture: typeof first) =>
      (await sql<{ value: number }>`SELECT nextval(pg_get_serial_sequence('chat_outbox', 'cursor'))::int AS value`.execute(fixture.db)).rows[0].value;
    expect(await nextSequence(first)).toBe(1);
    expect(await nextSequence(first)).toBe(2);
    expect(await nextSequence(second)).toBe(1);
    const third = await bots();
    expect(await third.db.selectFrom('bot_memory_items').selectAll().execute()).toEqual([]);
    expect(await nextSequence(third)).toBe(1);
    await expect(bootstrapBotDatabase(third.db)).resolves.toEqual({ applied: [] });
  });
});
