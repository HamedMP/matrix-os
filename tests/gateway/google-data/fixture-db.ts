import pg from 'pg';
import { Kysely } from 'kysely';
import { afterAll, afterEach } from 'vitest';
import { createNativeFixtureManager } from '../../platform/native-platform-db-test-helper.js';
import { createTestPGlite } from '../../helpers/pglite-test-helper.js';
import { createGoogleDataRepository } from '../../../packages/gateway/src/google-data/repository.js';
import { now } from './fixtures.js';
function bootstrap(dialect: any) {
  const sql = new Kysely<any>({ dialect });
  const repository = createGoogleDataRepository(sql, { now: () => now });
  return { sql, repository, ready: repository.migrate(), destroy: () => sql.destroy() };
}
const manager = createNativeFixtureManager({ createPool: config => new pg.Pool({ ...config, max: 10 }), createDb: ({ dialect }) => bootstrap(dialect),
  createFallback: async () => { const pg = await createTestPGlite(); const db = bootstrap(pg.dialect); await db.ready; return { db }; }, destroyFallback: db => db.destroy() });
afterEach(() => manager.drainClones(), 60000);
afterAll(() => manager.shutdown(), 120000);
export const createAuthorityFixture = () => manager.createTestPlatformDb();
