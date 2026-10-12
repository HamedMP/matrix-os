import { KyselyPGlite } from 'kysely-pglite';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';

export interface TestPlatformDb {
  db: PlatformDB;
  instance: InstanceType<typeof KyselyPGlite>;
}

export interface TestPlatformDbOptions {
  /** Migration contracts must start from a new, unmigrated database. */
  freshSchema?: boolean;
}

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
// One immutable image per isolated Vitest module. Never retain a live DB here.
let snapshotPromise: Promise<Blob> | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'Unknown failure';
}

async function createInitializedDb(snapshot?: Blob): Promise<TestPlatformDb> {
  const instance = snapshot
    ? await KyselyPGlite.create({ loadDataDir: snapshot })
    : await KyselyPGlite.create();
  let db: PlatformDB | undefined;
  try {
    db = createPlatformDb({ dialect: instance.dialect });
    // Keep production startup/revision validation on every restored instance.
    await db.ready;
    return { db, instance };
  } catch (error) {
    console.error('[test-platform-db] Startup failed; disposing database:', errorMessage(error));
    try {
      if (db) await db.destroy();
      else await instance.client.close();
    } catch (cleanupError) {
      console.error('[test-platform-db] Startup cleanup failed:', errorMessage(cleanupError));
      throw new AggregateError([error, cleanupError], 'Test database startup and cleanup failed');
    }
    throw error;
  }
}

async function createSnapshot(): Promise<Blob> {
  const { db, instance } = await createInitializedDb();
  let snapshot: Blob;
  try {
    snapshot = await instance.client.dumpDataDir('none');
    if (snapshot.size === 0 || snapshot.size > MAX_SNAPSHOT_BYTES) {
      throw new Error('Test platform snapshot exceeds the nonempty 64 MiB size limit');
    }
  } catch (error) {
    console.error('[test-platform-db] Snapshot failed; disposing template:', errorMessage(error));
    try {
      await db.destroy();
    } catch (cleanupError) {
      console.error('[test-platform-db] Template cleanup failed:', errorMessage(cleanupError));
      throw new AggregateError([error, cleanupError], 'Test database snapshot and cleanup failed');
    }
    throw error;
  }
  await db.destroy();
  return snapshot;
}

function getSnapshot(): Promise<Blob> {
  snapshotPromise ??= createSnapshot().catch(error => {
    snapshotPromise = undefined;
    console.error('[test-platform-db] Snapshot initialization failed; cache cleared for retry:', errorMessage(error));
    throw error;
  });
  return snapshotPromise;
}

export async function createTestPlatformDb(options: TestPlatformDbOptions = {}): Promise<TestPlatformDb> {
  if (options.freshSchema) return createInitializedDb();
  return createInitializedDb(await getSnapshot());
}

export async function destroyTestPlatformDb(db: PlatformDB | undefined): Promise<void> {
  try {
    await db?.destroy();
  } catch (err: unknown) {
    if (!(err instanceof Error && /destroy/i.test(err.message))) {
      throw err;
    }
    console.warn('[test-platform-db] Suppressed known destroy error:', errorMessage(err));
  }
}
