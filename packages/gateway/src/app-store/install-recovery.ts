import {rename,rm} from 'node:fs/promises';
import {AppStoreInstallRecordSchema,type AppStoreInstallRecord} from '@matrix-os/contracts/app-store-gateway';
import {z} from 'zod/v4';
import {bundleDigest,encodeAppBundle} from '@matrix-os/contracts/app-store-bundle';
import {snapshotOwnerApp} from './snapshot.js';
import {readStoreProvenance,writeStoreProvenance} from './provenance.js';
import {writeCommunityGrants,removeCommunityGrant} from './capability-grants.js';
import {withStoreDirectory} from './private-state.js';
import {isFsError,pinDirectory} from '../app-gallery/pinned-directory.js';
import {withOwnerFileMutation} from '../owner-file-mutations.js';
import {invalidateAppIndexCache} from '../app-runtime/app-index.js';
export const PublicationJournalSchema=z.strictObject({record:AppStoreInstallRecordSchema,previous:AppStoreInstallRecordSchema.nullable()});
export function publicationRecoveryAction(input:{currentMatchesNew:boolean;currentMatchesPrevious:boolean;hasDestination:boolean;hasBackup:boolean}):'commit'|'restore'|'rollback'|'conflict'{
 if(input.currentMatchesNew)return 'commit';if(input.hasDestination)return input.currentMatchesPrevious?'rollback':'conflict';return input.hasBackup?'restore':'rollback';
}
export async function installedMatches(homePath:string,record:AppStoreInstallRecord):Promise<boolean>{
 try{const source=await snapshotOwnerApp(homePath,record.appSlug);const dist=await snapshotOwnerApp(homePath,record.appSlug,'dist');return bundleDigest(encodeAppBundle('source',source))===record.installedSourceSha256&&bundleDigest(encodeAppBundle('dist',dist))===record.distSha256;}
 catch(error:unknown){if(isFsError(error,'ENOENT'))return false;throw error;}
}
/** Called before admitting new jobs. Unknown owner edits keep their recovery backup intact. */
export async function recoverInstallPublications(homePath:string):Promise<void>{return withOwnerFileMutation(homePath,()=>withStoreDirectory(homePath,['install-stages'],async stages=>{
 let visited=0;
 for await(const entry of await stages.entries()){if(++visited>64)throw new Error('Publication recovery limit');if(!/^[0-9a-f-]{36}$/.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink())continue;const stage=await stages.child(entry.name);let remove=false;
 try{let journal:z.infer<typeof PublicationJournalSchema>;try{journal=PublicationJournalSchema.parse(JSON.parse((await stage.readFile('journal.json',65_536)).toString('utf8')));}catch(error:unknown){if(isFsError(error,'ENOENT')){remove=true;continue;}throw error;}
 const {record,previous}=journal;const state=await readStoreProvenance(homePath);const live=state.installs.find(row=>row.listingSlug===record.listingSlug);
 // A completed newer publication must never be rolled back by an old retained journal.
 if(live&&live.versionId!==record.versionId&&live.versionId!==previous?.versionId){remove=true;continue;}
 const owner=await pinDirectory(homePath);let apps;try{apps=await owner.ensureChild('apps');let hasDestination=false,hasBackup=false;for await(const row of await apps.entries()){if(row.name===record.appSlug)hasDestination=true;}for await(const row of await stage.entries()){if(row.name==='backup'&&row.isDirectory()&&!row.isSymbolicLink())hasBackup=true;}
 const action=publicationRecoveryAction({currentMatchesNew:await installedMatches(homePath,record),currentMatchesPrevious:previous?await installedMatches(homePath,previous):false,hasDestination,hasBackup});
 if(action==='conflict'){throw new Error('Publication recovery requires owner review');}
 if(action==='restore')await rename(`${stage.path}/backup`,`${apps.path}/${record.appSlug}`);
 const chosen=action==='commit'?record:previous;
 await writeStoreProvenance(homePath,{version:1,installs:[...state.installs.filter(row=>row.listingSlug!==record.listingSlug),...(chosen?[chosen]:[])]});
 if(chosen)await writeCommunityGrants(homePath,chosen);else await removeCommunityGrant(homePath,record.appSlug);invalidateAppIndexCache();remove=true;
 }finally{await apps?.close();await owner.close();}
 }finally{await stage.close();if(remove)await rm(`${stages.path}/${entry.name}`,{recursive:true,force:true});}
 }
}));}
