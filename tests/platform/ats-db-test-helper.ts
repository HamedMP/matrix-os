import { KyselyPGlite } from 'kysely-pglite';
import { createAtsDb, type AtsDB } from '../../packages/platform/src/ats-db.js';

export async function createTestAtsDb(): Promise<{ db: AtsDB; instance: InstanceType<typeof KyselyPGlite> }> {
  const instance = await KyselyPGlite.create();
  const db = createAtsDb({ dialect: instance.dialect });
  await db.ready;
  return { db, instance };
}

export async function destroyTestAtsDb(db: AtsDB | undefined): Promise<void> {
  await db?.destroy();
}
