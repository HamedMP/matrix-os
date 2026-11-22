import { describe, expect, it } from 'vitest';
import { createPlatformDb } from '../../packages/platform/src/db.js';
import { METAL_MAINTENANCE_LOCK_KEY, METAL_SLEEPER_LOCK_KEY, runAsSingleton } from '../../packages/platform/src/substrates/metal-singleton.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

/**
 * Metal background passes run under a Postgres advisory lock (spec 2691,
 * ENG-520), so two dedicated worker instances overlapping during a deploy
 * never run the same pass. Fault detected: both instances suspending or
 * tearing down the same VMs at once.
 */
describe('metal background pass singleton', () => {
  it('runs the pass when the lock is free, and the maintenance and sleeper locks differ', async () => {
    const { db } = await createTestPlatformDb();
    try {
      let ran = 0;
      expect(await runAsSingleton(db, METAL_MAINTENANCE_LOCK_KEY, async () => { ran += 1; })).toBe(true);
      expect(ran).toBe(1);
      expect(METAL_MAINTENANCE_LOCK_KEY).not.toBe(METAL_SLEEPER_LOCK_KEY);
    } finally {
      await destroyTestPlatformDb(db);
    }
  });

  it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)('a second instance skips the pass while the first holds the lock (real Postgres)', async () => {
    const first = createPlatformDb(process.env.MATRIX_TEST_POSTGRES_URL!);
    const second = createPlatformDb(process.env.MATRIX_TEST_POSTGRES_URL!);
    try {
      let release!: () => void;
      const holding = new Promise<void>((resolve) => { release = resolve; });
      let secondRan = false;
      const firstPass = runAsSingleton(first, METAL_SLEEPER_LOCK_KEY, async () => {
        expect(await runAsSingleton(second, METAL_SLEEPER_LOCK_KEY, async () => { secondRan = true; })).toBe(false);
        release();
      });
      await holding;
      expect(await firstPass).toBe(true);
      expect(secondRan).toBe(false);
      // Released with the transaction.
      expect(await runAsSingleton(second, METAL_SLEEPER_LOCK_KEY, async () => { secondRan = true; })).toBe(true);
    } finally {
      await first.destroy?.();
      await second.destroy?.();
    }
  });
});
