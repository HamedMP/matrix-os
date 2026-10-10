import { KyselyPGlite } from 'kysely-pglite';

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
// Cache only immutable initdb bytes in this isolated test module, never a live DB.
let snapshotPromise: Promise<Blob> | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'Unknown failure';
}

async function createSnapshot(): Promise<Blob> {
  const template = await KyselyPGlite.create();
  let snapshot: Blob;
  try {
    // Do not bootstrap any application schema into the reusable template.
    snapshot = await template.client.dumpDataDir('none');
    if (snapshot.size === 0 || snapshot.size > MAX_SNAPSHOT_BYTES) {
      throw new Error('Empty PostgreSQL snapshot exceeds the nonempty 64 MiB size limit');
    }
  } catch (error) {
    console.error('[test-pglite] Snapshot failed; disposing template:', errorMessage(error));
    try {
      await template.client.close();
    } catch (cleanupError) {
      console.error('[test-pglite] Template cleanup failed:', errorMessage(cleanupError));
      throw new AggregateError([error, cleanupError], 'Empty PostgreSQL snapshot and cleanup failed');
    }
    throw error;
  }
  try {
    // Publication must wait for closure: no cached live connection or engine.
    await template.client.close();
  } catch (error) {
    console.error('[test-pglite] Template cleanup failed:', errorMessage(error));
    throw error;
  }
  return snapshot;
}

function getSnapshot(): Promise<Blob> {
  snapshotPromise ??= createSnapshot().catch(error => {
    snapshotPromise = undefined;
    console.error('[test-pglite] Snapshot initialization failed; cache cleared for retry:', errorMessage(error));
    throw error;
  });
  return snapshotPromise;
}

/** Fresh empty engine; callers still own normal application bootstrap and close. */
export async function createTestPGlite(): Promise<InstanceType<typeof KyselyPGlite>> {
  return KyselyPGlite.create({ loadDataDir: await getSnapshot() });
}
