import pg from 'pg';
import { afterAll, afterEach } from 'vitest';
import { createPlatformDb, type PlatformDb } from '../../packages/gateway/src/platform-db.js';
import { createTestPGlite } from '../helpers/pglite-test-helper.js';
import { createNativeFixtureManager, type FixtureDatabase } from '../platform/native-platform-db-test-helper.js';

type IntegrationFixtureDb = PlatformDb & FixtureDatabase;
function bootstrap(dialect: unknown): IntegrationFixtureDb {
  const db = createPlatformDb({ dialect });
  const destroy = db.destroy.bind(db);
  let closing: Promise<void> | undefined;
  return Object.assign(db, {
    // The existing gateway migration path runs on every fresh clone, too.
    ready: db.migrate(),
    destroy: () => {
      closing ??= destroy().catch(error => {
        closing = undefined;
        console.error('[integration-db-fixture] Database closure failed:',
          error instanceof Error ? error.message.slice(0, 300) : 'Unknown failure');
        throw error;
      });
      return closing;
    },
  });
}
export function createNativeIntegrationFixtureManager() {
  return createNativeFixtureManager({
    createPool: config => new pg.Pool(config),
    createDb: ({ dialect }) => bootstrap(dialect),
    createFallback: async () => {
      const instance = await createTestPGlite();
      let db: IntegrationFixtureDb | undefined;
      try {
        db = bootstrap(instance.dialect);
        await db.ready;
        return { db };
      }
      catch (error) {
        console.error('[integration-db-fixture] Gateway migration failed:',
          error instanceof Error ? error.message.slice(0, 300) : 'Unknown failure');
        try {
          if (db) await db.destroy();
          else await instance.client.close();
        }
        catch (cleanupError) {
          console.error('[integration-db-fixture] Startup cleanup failed:',
            cleanupError instanceof Error ? cleanupError.message.slice(0, 300) : 'Unknown failure');
          throw new AggregateError([error, cleanupError], 'Integration fixture startup and cleanup failed');
        }
        throw error;
      }
    },
    destroyFallback: db => db.destroy(),
  });
}
const manager = createNativeIntegrationFixtureManager();
afterEach(() => manager.drainClones(), 60_000);
afterAll(() => manager.shutdown(), 120_000);
export const createTestIntegrationDb = () => manager.createTestPlatformDb();
