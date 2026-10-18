import type { PlatformDB } from '../db.js';
import type { StoreObjects } from './object-store.js';
import { storeSourceKey, storeUploadKey } from './storage-keys.js';
import { appendStoreEvent } from './repository-events.js';
export function createStoreSweeper(db: PlatformDB, objects: StoreObjects, now = () => Date.now()) {
  let interval: ReturnType<typeof setInterval> | undefined; let running: Promise<void> | undefined; let closed = false;
  async function perform() {
    await db.executor.updateTable('app_store_versions').set({ status: 'awaiting_upload', scanning_started_at: null, updated_at: new Date(now()).toISOString() })
      .where('status', '=', 'scanning').where('scanning_started_at', '<', new Date(now() - 600_000).toISOString()).execute();
    const candidates = await db.executor.selectFrom('app_store_versions').select('id').where('status', '=', 'awaiting_upload')
      .where('created_at', '<', new Date(now() - 87_300_000).toISOString()).orderBy('created_at').limit(10).execute();
    for (const candidate of candidates) {
      if (closed) return;
      await db.transaction(async trx => {
        const version = await trx.executor.selectFrom('app_store_versions').selectAll().where('id', '=', candidate.id).where('status', '=', 'awaiting_upload').forUpdate().executeTakeFirst();
        if (!version) return;
        // Delete while holding the row lock so finalize cannot claim the upload.
        // Failure rolls back deletion and leaves a durable retry candidate.
        await objects.delete(version.source_object_key);
        await objects.delete(storeSourceKey(version.submitted_by_clerk_user_id, version.id, version.source_sha256));
        await appendStoreEvent(trx, { actor_kind: 'system', actor_clerk_user_id: null, action: 'expired', listing_id: version.listing_id, version_id: version.id, message: null }, new Date(now()).toISOString());
        await trx.executor.deleteFrom('app_store_versions').where('id', '=', version.id).where('status', '=', 'awaiting_upload').execute();
      });
    }
    const uploads = await db.executor.selectFrom('app_store_versions').select('id').where('status', 'not in', ['awaiting_upload', 'scanning'])
      .where('upload_cleaned_at', 'is', null).where('created_at', '<', new Date(now() - 87_300_000).toISOString()).orderBy('created_at').limit(20).execute();
    for (const candidate of uploads) {
      if (closed) return;
      await db.transaction(async trx => {
        const version = await trx.executor.selectFrom('app_store_versions').selectAll().where('id', '=', candidate.id).where('upload_cleaned_at', 'is', null).forUpdate().executeTakeFirst();
        if (!version || version.status === 'awaiting_upload' || version.status === 'scanning') return;
        await objects.delete(storeUploadKey(version.submitted_by_clerk_user_id, version.id));
        await trx.executor.updateTable('app_store_versions').set({ upload_cleaned_at: new Date(now()).toISOString() }).where('id', '=', version.id).execute();
      });
    }
  }
  function sweep(): Promise<void> {
    if (closed) return Promise.resolve();
    running ??= perform().finally(() => { running = undefined; }); return running;
  }
  return { sweep, start() {
    if (closed || interval) return;
    const run = () => { void sweep().catch(error => console.error('[app-store] Cleanup failed', error)); };
    run(); interval = setInterval(run, 3_600_000); interval.unref();
  }, async shutdown() { closed = true; if (interval) clearInterval(interval); interval = undefined; await running; } };
}
