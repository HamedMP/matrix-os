import type { Kysely } from 'kysely';
import type { ChatDatabase } from '../chat/database.js';
import type { GoogleDataPilotConfig } from '../google-data/runtime/pilot-config.js';
import { createGoogleProvenanceStore } from '../google-data/provenance/store.js';
import { createGoogleCanonicalMessageWriteHook } from '../google-data/provenance/canonical-message-writes.js';
import { createGoogleActivityCopyAdapter, type GoogleActivityQuiescenceAuthority } from '../google-data/provenance/activity-copies.js';
import { createGoogleContextSnapshotAdapter, type GoogleQueueContextAdmission } from '../google-data/provenance/context-snapshot-copies.js';
import { createGoogleManagedPiCopyHooks } from '../google-data/provenance/managed-copy-writes.js';
import { GoogleProvenanceUnavailable } from '../google-data/provenance/contracts.js';

/** Pool-free construction before repository registration. Strict hooks are installed only on
 * the operator-selected pilot host. Missing stop/queue authority always denies purge work. */
export function createGooglePilotStorage(database: Kysely<ChatDatabase>, pilot?: GoogleDataPilotConfig) {
  if (!pilot?.enabled) return undefined;
  let stop: GoogleActivityQuiescenceAuthority | undefined; let queue: GoogleQueueContextAdmission | undefined;
  const quiescence: GoogleActivityQuiescenceAuthority = { withStoppedRun: (key, work) => {
    if (!stop || key.ownerId !== pilot.ownerId) throw new GoogleProvenanceUnavailable(); return stop.withStoppedRun(key, work);
  } };
  const queueAdmission: GoogleQueueContextAdmission = { withStoppedQueue: (key, work) => {
    if (!queue || key.ownerId !== pilot.ownerId) throw new GoogleProvenanceUnavailable(); return queue.withStoppedQueue(key, work);
  } };
  const provenance = createGoogleProvenanceStore(database);
  const context = createGoogleContextSnapshotAdapter(database, { quiescence, queueAdmission });
  const activity = createGoogleActivityCopyAdapter(database, { quiescence });
  const canonical = createGoogleCanonicalMessageWriteHook();
  const sessions = createGoogleManagedPiCopyHooks();
  return Object.freeze({ context, activity, canonical, sessions, provenance,
    installQuiescence(authority: GoogleActivityQuiescenceAuthority, queued: GoogleQueueContextAdmission) {
      if (stop || queue) throw new GoogleProvenanceUnavailable(); stop = authority; queue = queued;
    },
    async migrate() { await provenance.migrate(); await context.migrate(); await activity.migrate(); },
  });
}
export type GooglePilotStorage = NonNullable<ReturnType<typeof createGooglePilotStorage>>;
