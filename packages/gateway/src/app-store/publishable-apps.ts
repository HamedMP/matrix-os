import {join} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {AppGalleryCatalogSchema} from '@matrix-os/contracts/app-gallery';
import {OwnerAppSlugSchema,type AppStorePublishableApp} from '@matrix-os/contracts/app-store-gateway';
import {listUniqueAppManifests} from '../app-runtime/app-index.js';
import {readStoreProvenance} from './provenance.js';
let bundled:Promise<ReadonlySet<string>>|undefined;
function bundledSlugs():Promise<ReadonlySet<string>>{
 return bundled??=(async()=>{
  const directories=await readdir(new URL('../../../../home/apps/',import.meta.url),{withFileTypes:true});
  const catalog=AppGalleryCatalogSchema.parse(JSON.parse(await readFile(new URL('../../../../home/system/app-gallery.json',import.meta.url),'utf8')));
  // Immutable package metadata; replaced on process restart, with no owner-controlled growth.
  const slugs=new Set([...directories.filter(entry=>entry.isDirectory()).map(entry=>entry.name),...catalog.apps.map(app=>app.id)]);
  if(slugs.size>1000)throw new Error('Bundled app metadata limit');return slugs;
 })();
}
/** Legacy HTML has no stable manifest identity; community provenance survives owner manifest edits. */
export async function publishableStoreApps(homePath:string):Promise<AppStorePublishableApp[]>{
 const entries=await listUniqueAppManifests(join(homePath,'apps'));
 const records=(await readStoreProvenance(homePath)).installs;
 const firstParty=await bundledSlugs();
 return entries.filter(entry=>entry.relativePath===entry.slug&&OwnerAppSlugSchema.safeParse(entry.slug).success).slice(0,500).map(entry=>{
  const reason=records.some(record=>record.appSlug===entry.relativePath)||entry.manifest.listingTrust==='community'?'community'
   :firstParty.has(entry.slug)||entry.manifest.listingTrust==='first_party'?'bundled':entry.manifest.runtime!=='vite'?'unsupported_runtime':undefined;
  return {slug:entry.slug,name:entry.manifest.name,...(entry.manifest.description?{description:entry.manifest.description}:{}),eligible:!reason,...(reason?{reason}: {})};
 });
}
