import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformDatabase } from '../../packages/platform/src/db.js';
import { createDevstackRunStore, migrateDevstackRuns, type DevstackRunAdmission } from '../../packages/platform/src/devstack-runs/store.js';

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const keyDigest = 'a'.repeat(64);
const owner = 'user_devstack_fixture';
function admission(): DevstackRunAdmission {
  return {
    runId: randomUUID(), owner, keyDigest, requestDigest: 'b'.repeat(64), runtime: 'stage-two',
    worktree: 'feature-a', containerId: 'c'.repeat(64), cwd: 'projects/feature-a', revision: 'd'.repeat(40),
    previewUrl: 'https://devstack.example.test/vm/devstack-fixture/', kind: 'test',
  };
}

describe.skipIf(!connectionString)('DevStack retained runs on PostgreSQL', () => {
  let admin: Kysely<PlatformDatabase>;
  let db: Kysely<PlatformDatabase>;
  let reader: Kysely<PlatformDatabase>;
  let schema: string;

  beforeEach(async () => {
    if (!connectionString) throw new Error('DevStack PostgreSQL fixture is unavailable');
    const url = new URL(connectionString);
    if (!['127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/[A-Za-z0-9_]+_test$/.test(url.pathname)
      || url.search || url.hash) throw new Error('Disposable literal-loopback PostgreSQL test database required');
    schema = 'devstack_runs_' + randomUUID().replaceAll('-', '');
    const connect = (options?: string) => new Kysely<PlatformDatabase>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 2, options }) }),
    });
    admin = connect();
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = connect(`-c search_path=${schema} -c statement_timeout=8000 -c lock_timeout=5000`);
    reader = connect(`-c search_path=${schema} -c statement_timeout=8000 -c lock_timeout=5000`);
    await Promise.all([migrateDevstackRuns(db), migrateDevstackRuns(reader)]);
  });

  afterEach(async () => {
    try { await Promise.all([db?.destroy(), reader?.destroy()]); }
    finally {
      try { if (schema && admin) await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); }
      finally { await admin?.destroy(); }
    }
  });

  it('atomically admits one launch, excludes a competing worktree launch and preserves the result for another connection', async () => {
    const write = createDevstackRunStore(db);
    const read = createDevstackRunStore(reader);
    const input = admission();
    const outcomes = await Promise.all([write.admit(input), read.admit(input)]);
    expect(outcomes.map(result => result.outcome).sort()).toEqual(['admitted', 'replay']);
    expect(await read.admit({ ...input, requestDigest: 'f'.repeat(64) })).toEqual({ outcome: 'conflict' });
    expect(await read.admit({ ...input, keyDigest: 'e'.repeat(64) })).toEqual({ outcome: 'missing' });
    expect(await read.admit({ ...input, runId: randomUUID() })).toEqual({ outcome: 'busy' });
    expect(await read.read(input.runId, owner, 'e'.repeat(64))).toBeUndefined();
    expect(await read.read(input.runId, 'user_peer', keyDigest)).toBeUndefined();
    expect(await read.read(input.runId, owner, keyDigest)).toMatchObject({ status: 'running', exitCode: null });

    await write.finish(input.runId, { status: 'failed', exitCode: 7, logs: [{ stream: 'stderr', text: 'test failed' }], truncated: false });
    expect(await read.read(input.runId, owner, keyDigest)).toMatchObject({
      runId: input.runId, status: 'failed', exitCode: 7, logs: [{ stream: 'stderr', text: 'test failed' }],
    });
    expect(await read.admit(input)).toMatchObject({ outcome: 'replay', record: { status: 'failed', exitCode: 7 } });
    expect(await read.admit({ ...input, runId: randomUUID() })).toMatchObject({ outcome: 'admitted' });
  });

  it('treats an expired execution as interrupted and fences late completion and replay', async () => {
    const write = createDevstackRunStore(db);
    const read = createDevstackRunStore(reader);
    const input = admission();
    await write.admit(input);
    await sql`UPDATE devstack_runs SET lease_until = NOW() - interval '1 second' WHERE run_id = ${input.runId}`.execute(db);
    expect(await read.read(input.runId, owner, keyDigest)).toMatchObject({ status: 'interrupted', exitCode: null });
    await write.finish(input.runId, { status: 'succeeded', exitCode: 0, logs: [], truncated: false });
    expect(await read.admit(input)).toMatchObject({ outcome: 'replay', record: { status: 'interrupted', exitCode: null } });
    expect(await read.admit({ ...input, runId: randomUUID() })).toMatchObject({ outcome: 'admitted' });
  });

  it('keeps the worktree fenced when transport fails after a possible dispatch', async () => {
    const write = createDevstackRunStore(db);
    const read = createDevstackRunStore(reader);
    const input = admission();
    await write.admit(input);

    await write.finish(input.runId, { status: 'interrupted', exitCode: null, logs: [], truncated: false });
    expect(await read.read(input.runId, owner, keyDigest)).toMatchObject({ status: 'interrupted' });
    expect(await read.admit({ ...input, runId: randomUUID() })).toEqual({ outcome: 'busy' });

    await sql`UPDATE devstack_runs SET lease_until = NOW() - interval '1 second' WHERE run_id = ${input.runId}`.execute(db);
    expect(await read.admit({ ...input, runId: randomUUID() })).toMatchObject({ outcome: 'admitted' });
  });
});
