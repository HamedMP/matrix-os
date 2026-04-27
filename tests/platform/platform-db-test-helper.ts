import { KyselyPGlite } from 'kysely-pglite';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';

export interface TestPlatformDb {
  db: PlatformDB;
  instance: InstanceType<typeof KyselyPGlite>;
}

export async function createTestPlatformDb(): Promise<TestPlatformDb> {
  const instance = await KyselyPGlite.create();
  const db = createPlatformDb({ dialect: instance.dialect });
  await db.ready;
  return { db, instance };
}

export async function destroyTestPlatformDb(db: PlatformDB | undefined): Promise<void> {
  try {
    await db?.destroy();
  } catch (err: unknown) {
    if (!(err instanceof Error && /destroy/i.test(err.message))) {
      throw err;
    }
  }
}
