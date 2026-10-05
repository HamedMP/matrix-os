import { z } from 'zod/v4';
import type { PlatformDB } from '../db.js';
import { ownerStoragePrefixes, type AccountDeletionObjectStore } from './storage.js';

const cursorSchema = z.object({ prefixIndex: z.number().int().min(0).max(1), continuation: z.string().max(2048).optional() }).strict();
export interface AccountExportFiles {
  files: Array<{ path: string; kind: 'database' | 'file'; downloadUrl: string; expiresIn: number }>;
  nextCursor: string | null;
  migrationInstructions: string;
}
/** Caller authenticates owner; client cursor can select a page, never an object key or another owner. */
export async function listAccountExportFiles(store: AccountDeletionObjectStore, owner: string, root: string,
  cursor?: string): Promise<AccountExportFiles> {
  if (!store.getPresignedGetUrl) throw new Error('Account export unavailable');
  const prefixes = ownerStoragePrefixes(owner, root);
  const selected = cursor ? cursorSchema.parse(JSON.parse(Buffer.from(z.string().max(4096).parse(cursor),'base64url').toString()))
    : { prefixIndex:0, continuation:undefined };
  const prefix = prefixes[selected.prefixIndex];
  if (!prefix) throw new Error('Export cursor invalid');
  const page = await store.listObjects(prefix,selected.continuation);
  if (page.keys.length > 1000) throw new Error('Export inventory capacity exceeded');
  if (page.keys.some((key)=>!key.startsWith(prefix))) throw new Error('Storage ownership mismatch');
  const files: AccountExportFiles['files'] = [];
  for (const key of page.keys) {
    const path = key.slice(prefix.length);
    // Internal reachability metadata is not part of the owner's portable files/database export.
    if (path==='system/vps-meta.json') continue;
    files.push({path,kind:path.endsWith('.dump')?'database':'file',downloadUrl:await store.getPresignedGetUrl(key,900),expiresIn:900});
  }
  const next = page.nextCursor ? {prefixIndex:selected.prefixIndex,continuation:page.nextCursor}
    : selected.prefixIndex+1<prefixes.length ? {prefixIndex:selected.prefixIndex+1} : null;
  return { files,nextCursor:next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
    migrationInstructions:'Download all pages of backed-up files and PostgreSQL .dump snapshots before erasure begins. These are the existing synced backups; check their timestamps. Keep your computer open during the grace period to export any unsynced files and a fresh PostgreSQL dump. Copy the downloaded home files to your new Matrix home and restore each PostgreSQL snapshot with pg_restore into an owner-controlled PostgreSQL database. Transfer shared project and organization ownership and move their storage to a retained computer before deleting this account.' };
}

/** Downloadable platform export excludes credentials, delivery payloads, billing keys and access tokens. */
export async function exportOwnerPlatformData(db: PlatformDB, owner: string) {
  z.string().regex(/^user_[A-Za-z0-9_-]{1,150}$/).parse(owner);
  await db.ready;
  return db.transaction(async (trx)=> {
    const profile = await trx.executor.selectFrom('users').select(['id','clerk_id','handle','display_name','email','plan','status','created_at','updated_at'])
      .where('clerk_id','=',owner).execute();
    const ids = [owner,...profile.map((user)=>user.id)];
    const posts = await trx.executor.selectFrom('social_posts').selectAll().where('author_id','in',ids).limit(10001).execute();
    const comments = await trx.executor.selectFrom('social_comments').selectAll().where('author_id','in',ids).limit(10001).execute();
    const likes = await trx.executor.selectFrom('social_likes').selectAll().where('user_id','in',ids).limit(10001).execute();
    const follows = await trx.executor.selectFrom('social_follows').selectAll().where('follower_id','in',ids).limit(10001).execute();
    const machines = await trx.executor.selectFrom('user_machines').select(['machine_id','handle','runtime_slot','status','provisioned_at','deleted_at'])
      .where('clerk_user_id','=',owner).limit(1001).execute();
    const billing = await trx.executor.selectFrom('billing_subscriptions').select(['runtime_slot','plan_slug','status','billing_interval','current_period_end'])
      .where('clerk_user_id','=',owner).limit(1001).execute();
    const onboarding = await trx.executor.selectFrom('onboarding_first_run').select(['completed_at','goal','steps','source'])
      .where('clerk_user_id','=',owner).execute();
    if ([posts,comments,likes,follows].some((rows)=>rows.length>10000) || machines.length>1000 || billing.length>1000) {
      throw new Error('Platform export capacity exceeded');
    }
    return { version:1,exportedAt:new Date().toISOString(),profile,posts,comments,likes,follows,machines,billing,onboarding };
  });
}
