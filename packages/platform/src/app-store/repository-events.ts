import { randomUUID } from 'node:crypto';
import type { PlatformDB } from '../db.js';
import type { StoreEventRow } from './types.js';
export function appendStoreEvent(db: PlatformDB, event: Omit<StoreEventRow, 'id' | 'created_at'>, now: string) {
  return db.executor.insertInto('app_store_moderation_events').values({ ...event, id: randomUUID(), created_at: now }).execute();
}
export async function storeEvents(db: PlatformDB, listingId: string) {
  return db.executor.selectFrom('app_store_moderation_events').selectAll().where('listing_id', '=', listingId).orderBy('created_at', 'desc').orderBy('id').limit(100).execute();
}
