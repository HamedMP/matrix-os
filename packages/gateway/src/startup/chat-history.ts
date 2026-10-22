import { createGooglePilotStorage } from './google-pilot-storage.js';
import type { GoogleDataPilotConfig } from '../google-data/runtime/pilot-config.js';
import type { Kysely } from 'kysely';
import type { ChatDatabase } from '../chat/database.js';
import { ChatRepository } from '../chat/repository.js';
import { createGoogleModelHistoryStore } from '../google-data/runtime/model-history.js';

/** Owner startup must await bootstrap before exposing the repository. Only actual
 * successful empty-chat inserts receive a birth; no historical rows are certified.
 * The host retains the database/pool and releases this repository on startup failure.
 * This installs classification, never model admission, recipient consent or approval. */
export function createOwnerChatHistoryRepository(database: Kysely<ChatDatabase>, options: { pilot?: GoogleDataPilotConfig } = {}) {
  const history = createGoogleModelHistoryStore<ChatDatabase>(database);
  const googleCopies = createGooglePilotStorage(database, options.pilot);
  const repository = new ChatRepository(database, false, undefined, {
    ...(googleCopies ? { assistantDeltaWrites: googleCopies.canonical, activityWrites: googleCopies.activity, contextWrites: googleCopies.context, contentProjectionMode: 'metadata-only' as const } : {}),
    onServerCreatedEmptyChat: (tx, owner, chatId, receipt) => history.recordServerCreatedEmptyChat<ChatDatabase>(tx, owner, chatId, receipt),
  });
  return { repository, googleCopies, async bootstrap(): Promise<void> {
    await repository.bootstrap();
    await history.migrate();
    await googleCopies?.migrate();
  } };
}
