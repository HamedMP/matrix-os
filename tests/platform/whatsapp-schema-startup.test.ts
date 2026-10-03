import { Kysely, sql } from 'kysely';
import { KyselyPGlite } from 'kysely-pglite';
import { describe, expect, it } from 'vitest';
import { createPlatformDb } from '../../packages/platform/src/db.js';
import type { PlatformDatabase } from '../../packages/platform/src/db.js';
import { PLATFORM_SCHEMA_REVISION } from '../../packages/platform/src/database/migration-revision.js';
import { runPlatformStartupMigrations } from '../../packages/platform/src/database/run-migrations.js';
import { WHATSAPP_SCHEMA_REVISION } from '../../packages/platform/src/database/whatsapp-migration-revision.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

describe('WhatsApp schema startup', () => {
  it('executes channel DDL only once on a fresh database and skips it on restart', async () => {
    const instance = await KyselyPGlite.create();
    let channelCreates = 0;
    const db = new Kysely<PlatformDatabase>({
      dialect: instance.dialect,
      log: (event) => {
        if (event.level === 'query' && event.query.sql.includes('CREATE TABLE IF NOT EXISTS whatsapp_connections')) channelCreates++;
      },
    });
    try {
      await runPlatformStartupMigrations(db);
      expect(channelCreates).toBe(1);
      const revisions = await sql<{ scope: string; generation: number; fingerprint: string }>`
        SELECT scope, generation, fingerprint FROM platform_schema_revisions ORDER BY scope
      `.execute(db);
      expect(revisions.rows).toEqual([
        { scope: 'core', ...PLATFORM_SCHEMA_REVISION },
        { scope: 'whatsapp', ...WHATSAPP_SCHEMA_REVISION },
      ]);
      await runPlatformStartupMigrations(db);
      expect(channelCreates).toBe(1);
    } finally { await db.destroy(); }
  });
  it('creates required channel tables even when a newer core revision already exists', async () => {
    const instance = await KyselyPGlite.create();
    await instance.client.exec(`CREATE TABLE platform_schema_revisions (
      scope TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const newerGeneration = PLATFORM_SCHEMA_REVISION.generation + 1;
    await instance.client.query('INSERT INTO platform_schema_revisions (scope, generation, fingerprint) VALUES ($1, $2, $3)',
      ['core', newerGeneration, 'newer-core']);
    const db = createPlatformDb({ dialect: instance.dialect });
    try {
      await db.ready;
      const tables = await sql<{ connections: string | null; challenges: string | null; jobs: string | null }>`
        SELECT to_regclass('whatsapp_connections')::text AS connections,
          to_regclass('whatsapp_link_challenges')::text AS challenges,
          to_regclass('whatsapp_jobs')::text AS jobs
      `.execute(db.kysely);
      expect(tables.rows[0]).toEqual({ connections: 'whatsapp_connections', challenges: 'whatsapp_link_challenges', jobs: 'whatsapp_jobs' });
      const revision = await sql<{ generation: number; fingerprint: string }>`
        SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'core'
      `.execute(db.kysely);
      expect(revision.rows[0]).toEqual({ generation: newerGeneration, fingerprint: 'newer-core' });
      const channel = await sql<{ generation: number; fingerprint: string }>`
        SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'whatsapp'
      `.execute(db.kysely);
      expect(channel.rows[0]).toEqual(WHATSAPP_SCHEMA_REVISION);
      await runPlatformStartupMigrations(db.kysely);
      const indexes = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_indexes
        WHERE indexname LIKE 'idx_whatsapp_%'`.execute(db.kysely);
      expect(indexes.rows[0]?.count).toBe(5);
    } finally { await db.destroy(); }
  });
  it('pins the channel revision to the exact reviewed migration source', async () => {
    const source = await readFile('packages/platform/src/database/migrations/whatsapp.ts');
    expect(WHATSAPP_SCHEMA_REVISION.generation).toBeGreaterThan(0);
    expect(WHATSAPP_SCHEMA_REVISION.fingerprint).toBe(createHash('sha256').update(source).digest('hex'));
  });
});
