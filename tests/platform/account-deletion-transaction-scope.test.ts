import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

let db: PlatformDB | undefined;
afterEach(async () => { await destroyTestPlatformDb(db); });
describe('platform transaction scope lifecycle', () => {
  it('does not reuse a committed request connection in deferred background work', async () => {
    ({ db } = await createTestPlatformDb());
    const database = db;
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let deferred!: Promise<unknown>;
    await database.transaction(async trx => {
      await sql`CREATE TABLE scope_result (value INTEGER)`.execute(trx.executor);
      await sql`INSERT INTO scope_result(value) VALUES(1)`.execute(database.executor);
      deferred = gate.then(() => sql`SELECT * FROM scope_result`.execute(database.executor));
    });
    resume();
    await expect(deferred).resolves.toMatchObject({ rows: [{ value: 1 }] });
  });
});
