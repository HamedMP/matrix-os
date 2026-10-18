import {indexOwnerApps} from '../app-gallery/owner-index.js';
import {resolveActiveDesignId} from '../apps.js';
import {rename,rm} from 'node:fs/promises';import {constants} from 'node:fs';import type {AppStoreInstallRecord} from '@matrix-os/contracts/app-store-gateway';
import type {AppStoreDownloadGrant} from '@matrix-os/contracts/app-store';
import {bundleDigest,encodeAppBundle} from '@matrix-os/contracts/app-store-bundle';
import {snapshotOwnerApp} from './snapshot.js';
import type {StoreToolchain} from './local-builder.js';
import {APP_STORE_FIXED_BUILD} from '@matrix-os/contracts/app-store';
import {withStoreDirectory,atomicPrivateFile} from './private-state.js';import {pinDirectory,isFsError,type PinnedDirectory} from '../app-gallery/pinned-directory.js';
import {readStoreProvenance,writeStoreProvenance} from './provenance.js';import {writeCommunityGrants,removeCommunityGrant} from './capability-grants.js';
import {withOwnerFileMutation} from '../owner-file-mutations.js';import {invalidateAppIndexCache} from '../app-runtime/app-index.js';import {StoreError} from './platform-client.js';
async function writeTree(root:PinnedDirectory,files:ReadonlyMap<string,Buffer>):Promise<void>{
 for(const[path,bytes]of files){const segments=path.split('/');const leaf=segments.pop()!;let directory=root;const opened:PinnedDirectory[]=[];
  try{for(const segment of segments){directory=await directory.ensureChild(segment);opened.push(directory);}const handle=await directory.openFile(leaf,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL);try{await handle.writeFile(bytes);}finally{await handle.close();}}
  finally{for(const child of opened.reverse())await child.close();}
 }
}
export async function publishCommunityInstall(options:{homePath:string;jobId:string;listingSlug:string;grant:AppStoreDownloadGrant;source:ReadonlyMap<string,Buffer>;dist:ReadonlyMap<string,Buffer>;distSha256:string;toolchain:StoreToolchain}):Promise<AppStoreInstallRecord>{
 return withOwnerFileMutation(options.homePath,async()=>{
  const state=await readStoreProvenance(options.homePath);const previous=state.installs.find(row=>row.listingSlug===options.listingSlug);if(!previous&&state.installs.length>=500)throw new StoreError('limit');
  let previousPresent=false;if(previous){try{previousPresent=true;if(bundleDigest(encodeAppBundle('source',await snapshotOwnerApp(options.homePath,previous.appSlug)))!==previous.installedSourceSha256)throw new StoreError('conflict');}catch(error:unknown){if(isFsError(error,'ENOENT'))previousPresent=false;else throw error;}}
  const owner=await pinDirectory(options.homePath);const apps=await owner.ensureChild('apps');
  try{return await withStoreDirectory(options.homePath,['install-stages',options.jobId],async stage=>{
   let backedUp=false,published=false,rolledBack=false;
   let appSlug=previous?.appSlug??options.listingSlug;
   if(!previous){const index=await indexOwnerApps(apps,await resolveActiveDesignId(options.homePath));if(index.unavailable)throw new StoreError('conflict');for(let suffix=0;suffix<=9;suffix++){
    appSlug=suffix?`${options.listingSlug}-${suffix}`:options.listingSlug;
    if(index.entries.has(appSlug)){if(suffix===9)throw new StoreError('conflict');continue;}
    try{const occupied=await apps.child(appSlug);await occupied.close();}catch(error:unknown){if(isFsError(error,'ENOENT'))break;throw error;}
    if(suffix===9)throw new StoreError('conflict');
   }}
   const now=new Date().toISOString();const record:AppStoreInstallRecord={listingSlug:options.listingSlug,appSlug,versionId:options.grant.versionId,version:options.grant.version,sourceSha256:options.grant.source.sha256,distSha256:options.distSha256,installedSourceSha256:'0'.repeat(64),toolchain:options.toolchain,capabilities:options.grant.capabilities,installedAt:previous?.installedAt??now,updatedAt:now};
   const files=new Map(options.source);files.delete('matrix.json');for(const[path,bytes]of options.dist)files.set(`dist/${path}`,bytes);
   files.set('.build-stamp',Buffer.from(JSON.stringify({sourceHash:options.grant.source.sha256,lockfileHash:'store-reviewed-source',builtAt:Date.now(),exitCode:0})));
   const prepared=await stage.createChild('app');
   try{
    await writeTree(prepared,files);
    // A complete manifest is the discovery boundary, and carries no executable build script.
    const manifest={...options.grant.manifest,slug:appSlug,listingTrust:'community',build:{...APP_STORE_FIXED_BUILD,timeout:120},database:'postgres'};
    const manifestBytes=Buffer.from(JSON.stringify(manifest));await writeTree(prepared,new Map([['matrix.json',manifestBytes]]));
    const installedSource=new Map(options.source);installedSource.set('matrix.json',manifestBytes);record.installedSourceSha256=bundleDigest(encodeAppBundle('source',installedSource));
    await atomicPrivateFile(stage,'journal.json',Buffer.from(JSON.stringify({record,previous:previous??null})));
    if(previousPresent){await rename(`${apps.path}/${appSlug}`,`${stage.path}/backup`);backedUp=true;}
    // No app is visible while its consent, grants and provenance change.
    await writeCommunityGrants(options.homePath,record);
    await writeStoreProvenance(options.homePath,{version:1,installs:[...state.installs.filter(row=>row.listingSlug!==options.listingSlug),record]});
    await rename(`${stage.path}/app`,`${apps.path}/${appSlug}`);published=true;invalidateAppIndexCache();
    if(backedUp)try{await rm(`${stage.path}/backup`,{recursive:true});}catch(error:unknown){console.warn('[app-store] Previous clean install retained for recovery',error instanceof Error?error.name:'UnknownError');}
    return record;
   }catch(error:unknown){
    if(!published){
     await writeStoreProvenance(options.homePath,state);
     if(backedUp){await rename(`${stage.path}/backup`,`${apps.path}/${appSlug}`);}if(previous)await writeCommunityGrants(options.homePath,previous);else await removeCommunityGrant(options.homePath,appSlug);rolledBack=true;
    }throw error;
   }finally{await prepared.close();if(published||rolledBack)try{await withStoreDirectory(options.homePath,['install-stages'],parent=>rm(`${parent.path}/${options.jobId}`,{recursive:true,force:true}));}catch(error:unknown){console.warn('[app-store] Publication stage retained for reconciliation',error instanceof Error?error.name:'UnknownError');}}
  });}finally{await apps.close();await owner.close();}
 });
}
