import { afterAll, afterEach } from 'vitest';
import { createNativePlatformFixtureManager } from './native-platform-db-test-helper.js';
import { createTestPlatformDb as createPGliteDb } from './platform-db-test-helper.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';

// Global publication tests exercise concurrent transactions. PGlite needs a
// size-one pool for that contract; unrelated fixtures retain their own behavior.
const manager = createNativePlatformFixtureManager({
  createFallback: () => createPGliteDb({ serializeTransactions: true }),
});
afterEach(() => manager.drainClones(), 60_000);
afterAll(() => manager.shutdown(), 120_000);
export const createTestPlatformDb = () => manager.createTestPlatformDb();
export const destroyTestPlatformDb = (db: PlatformDB | undefined) => manager.destroyTestPlatformDb(db);
