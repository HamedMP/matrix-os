import { z } from 'zod/v4';
import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import { ownerStoragePrefixes, type AccountDeletionObjectStore } from './storage.js';

export interface AccountExportFiles {
  files: Array<{ path: string; kind: 'database' | 'file'; downloadUrl: string; expiresIn: number }>;
  nextCursor: string | null;
  migrationInstructions: string;
}
/** Caller authenticates owner; client cursor can select a page, never an object key or another owner. */
export async function listAccountExportFiles(store: AccountDeletionObjectStore, owner: string, root: string,
  cursor?: string, sitesStore?: AccountDeletionObjectStore): Promise<AccountExportFiles> {
  if (!store.getPresignedGetUrl) throw new Error('Account export unavailable');
  const prefixes = ownerStoragePrefixes(owner, root);
  const locations = [
    ...prefixes.map((prefix) => ({ store, prefix, pathPrefix: '' })),
    ...(sitesStore ? [{ store: sitesStore, prefix: `sites/owners/${owner}/`, pathPrefix: 'sites/' }] : []),
  ];
  const cursorSchema = z.object({ prefixIndex: z.number().int().min(0).max(locations.length - 1),
    continuation: z.string().max(2048).optional() }).strict();
  const selected = cursor ? cursorSchema.parse(JSON.parse(Buffer.from(z.string().max(4096).parse(cursor),'base64url').toString()))
    : { prefixIndex:0, continuation:undefined };
  const location = locations[selected.prefixIndex];
  if (!location || !location.store.getPresignedGetUrl) throw new Error('Export cursor invalid');
  const page = await location.store.listObjects(location.prefix,selected.continuation);
  if (page.keys.length > 1000) throw new Error('Export inventory capacity exceeded');
  if (page.keys.some((key)=>!key.startsWith(location.prefix))) throw new Error('Storage ownership mismatch');
  const files: AccountExportFiles['files'] = [];
  for (const key of page.keys) {
    const path = location.pathPrefix + key.slice(location.prefix.length);
    // Internal reachability metadata is not part of the owner's portable files/database export.
    if (path==='system/vps-meta.json') continue;
    files.push({path,kind:path.endsWith('.dump')?'database':'file',downloadUrl:await location.store.getPresignedGetUrl(key,900),expiresIn:900});
  }
  const next = page.nextCursor ? {prefixIndex:selected.prefixIndex,continuation:page.nextCursor}
    : selected.prefixIndex+1<locations.length ? {prefixIndex:selected.prefixIndex+1} : null;
  return { files,nextCursor:next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
    migrationInstructions:'Download all pages of backed-up files, published site assets and PostgreSQL .dump snapshots before erasure begins. These are the existing synced backups and immutable publication files; check their timestamps. Keep your computer open during the grace period to export any unsynced files and a fresh PostgreSQL dump. Copy the downloaded home files to your new Matrix home and restore each PostgreSQL snapshot with pg_restore into an owner-controlled PostgreSQL database. Transfer shared project and organization ownership and move their storage to a retained computer before deleting this account.' };
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
    const registry = await sql<{present:boolean}>`SELECT to_regclass('public_sites') IS NOT NULL AS present`.execute(trx.executor);
    const sites = registry.rows[0]?.present ? await trx.executor.selectFrom('public_sites').select([
      'id','machine_id','app_slug','title','description','slug','revision','status','active_version','created_at',
    ]).where('owner_id','=',owner).orderBy('id').limit(1001).execute() : [];
    const siteIds=sites.map(site=>site.id);
    const versions=siteIds.length ? await trx.executor.selectFrom('public_site_versions').selectAll()
      .where('site_id','in',siteIds).orderBy('site_id').orderBy('created_at').orderBy('id').limit(50001).execute() : [];
    const aliases=siteIds.length ? await trx.executor.selectFrom('public_site_aliases').select(['slug','site_id'])
      .where('site_id','in',siteIds).orderBy('slug').limit(10001).execute() : [];
    if ([posts,comments,likes,follows].some((rows)=>rows.length>10000) || machines.length>1000 || billing.length>1000
      || sites.length>1000 || versions.length>50000 || aliases.length>10000) {
      throw new Error('Platform export capacity exceeded');
    }
    return { version:2,exportedAt:new Date().toISOString(),profile,posts,comments,likes,follows,machines,billing,onboarding,
      publicSites:{sites,versions,aliases} };
  });
}
