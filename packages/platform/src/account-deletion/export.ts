import { z } from 'zod/v4';
import { decodeExportCursor, encodeExportCursor } from './export-cursor.js';
export { exportOwnerPlatformData } from './export-records.js';
import { ownerStoragePrefixes, type AccountDeletionObjectStore } from './storage.js';

export interface AccountExportFiles {
  files: Array<{ path: string; kind: 'database' | 'file'; downloadUrl: string; expiresIn: number; expiresAt: string; lastModified: string | null; sizeBytes: number | null }>;
  nextCursor: string | null;
  migrationInstructions: string;
  inventoryStatus: 'scanning' | 'available' | 'empty' | 'no_computer' | 'missing_backups';
}
/** Caller authenticates owner; client cursor can select a page, never an object key or another owner. */
export async function listAccountExportFiles(store: AccountDeletionObjectStore, owner: string, root: string,
  cursor?: string, options: { secret?: string; hasComputer?: boolean } = {}): Promise<AccountExportFiles> {
  if (!store.getPresignedGetUrl) throw new Error('Account export unavailable');
  const prefixes = ownerStoragePrefixes(owner, root);
  const cursorSchema = z.object({ prefixIndex: z.number().int().min(0).max(prefixes.length - 1),
    continuation: z.string().max(2048).optional(), seenFiles: z.boolean().optional() }).strict();
  const selected = cursor ? decodeExportCursor(cursor, owner, 'files:'+root, cursorSchema, options.secret)
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
    const metadata = page.objects?.find(object => object.key === key);
    files.push({path,kind:path.endsWith('.dump')?'database':'file',downloadUrl:await store.getPresignedGetUrl(key,900),expiresIn:900,
      expiresAt:new Date(Date.now()+900_000).toISOString(),lastModified:metadata?.lastModified??null,sizeBytes:metadata?.sizeBytes??null});
  }
  const seenFiles = ('seenFiles' in selected && selected.seenFiles === true) || files.length > 0;
  const next = page.nextCursor ? {prefixIndex:selected.prefixIndex,continuation:page.nextCursor,seenFiles}
    : selected.prefixIndex+1<prefixes.length ? {prefixIndex:selected.prefixIndex+1,seenFiles} : null;
  return { files,inventoryStatus:seenFiles?'available':next?'scanning':options.hasComputer===false?'no_computer':options.hasComputer===true?'missing_backups':'empty',nextCursor:next ? encodeExportCursor(next,owner,'files:'+root,options.secret) : null,
    migrationInstructions:'Download all pages of backed-up files and PostgreSQL .dump snapshots before erasure begins. These are existing synced backups, not a fresh snapshot. Object modification times are upload times, not proof of snapshot completeness. Check the source timestamps. Download links expire after 15 minutes; reload the list to refresh them. Refreshed objects may have changed. Keep your computer open during the grace period to export any unsynced files and a fresh PostgreSQL dump. Copy the downloaded home files to your new Matrix home and restore each PostgreSQL snapshot with pg_restore into an owner-controlled PostgreSQL database. Transfer shared project and organization ownership and move their storage to a retained computer before deleting this account.' };
}

