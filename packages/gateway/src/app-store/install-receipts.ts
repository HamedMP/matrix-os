import {AppStoreSlugSchema,AppStoreIdSchema} from '@matrix-os/contracts/app-store';
import type {AppStorePlatformClient} from './platform-client.js';
import {readStoreProvenance} from './provenance.js';import {snapshotOwnerApp} from './snapshot.js';
import {withStoreDirectory,atomicPrivateFile} from './private-state.js';import {isFsError} from '../app-gallery/pinned-directory.js';
/** Caller holds the owner mutation coordinator; state persists beyond the short-lived job history. */
export async function reconcileAbsentInstalls(homePath:string,platform:AppStorePlatformClient):Promise<void>{
 return withStoreDirectory(homePath,['install-receipts'],async directory=>{
  let absent:Record<string,string>={};try{const raw:unknown=JSON.parse((await directory.readFile('absent.json',65_536)).toString('utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>500)throw new Error('Invalid receipt state');for(const[key,value]of Object.entries(raw)){AppStoreSlugSchema.parse(key);absent[key]=AppStoreIdSchema.parse(value);}}catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}
  const installs=(await readStoreProvenance(homePath)).installs;let changed=false;
  for(const record of installs){let present=false;try{present=(await snapshotOwnerApp(homePath,record.appSlug)).has('matrix.json');}catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}
   if(present){if(absent[record.listingSlug]){delete absent[record.listingSlug];changed=true;}continue;}
   if(absent[record.listingSlug]===record.versionId)continue;await platform.removeInstall(record.listingSlug);absent[record.listingSlug]=record.versionId;changed=true;
  }
  for(const slug of Object.keys(absent)){if(!installs.some(row=>row.listingSlug===slug)){delete absent[slug];changed=true;}}
  if(changed)await atomicPrivateFile(directory,'absent.json',Buffer.from(JSON.stringify(absent)));
 });
}
