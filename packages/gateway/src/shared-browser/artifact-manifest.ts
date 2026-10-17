import {constants} from 'node:fs';
import {open,rename,unlink,opendir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod/v4';
import {SharedBrowserArtifactSchema,type SharedBrowserActionResult} from '@matrix-os/contracts';
import {openBrowserArtifactDirectory,assertDirectory} from './cdp-downloads.js';
import {SharedBrowserError} from './broker.js';

type Artifact=NonNullable<SharedBrowserActionResult['artifact']>;
/** Export evidence only: these files never grant run authority or assert page coverage. */
export async function writeBrowserArtifactManifest(homePath:string,collectionId:string,raw:Artifact[]):Promise<string>{
  if(!/^[a-f0-9-]{36}$/.test(collectionId) || raw.length<1 || raw.length>64)throw new SharedBrowserError('browser_unavailable',true);
  const artifacts=z.array(SharedBrowserArtifactSchema).parse(raw);
  const unique=artifacts.filter((row,index)=>artifacts.findIndex(other=>other.sha256===row.sha256)===index);
  const ids=[...new Set(artifacts.map(row=>row.documentId))]; // <=64, scoped to this export.
  const conflicts=ids.map(documentId=>({documentId,hashes:[...new Set(artifacts.filter(row=>row.documentId===documentId).map(row=>row.sha256))]})).filter(row=>row.hashes.length>1);
  const content=JSON.stringify({version:1,kind:'browser-original-collection',coverage:'downloads_only',
    downloadCount:artifacts.length,uniqueOriginalCount:unique.length,duplicateDownloadCount:artifacts.length-unique.length,
    artifacts:unique,receipts:artifacts,conflicts,updatedAt:new Date().toISOString()},null,2);
  const directory=await openBrowserArtifactDirectory(homePath);
  const name=`collection-${collectionId}.json`,temporary=`.manifest-${randomUUID()}`;
  let created=false;
  try{
    const entries=await opendir(directory.access);let count=0;
    for await(const _ of entries)if(++count>128)throw new SharedBrowserError('browser_unavailable',true);
    await assertDirectory(directory);
    const file=await open(join(directory.access,temporary),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;
    try{await file.writeFile(content);await file.sync();}finally{await file.close();}
    await assertDirectory(directory);await rename(join(directory.access,temporary),join(directory.access,name));created=false;
    return `data/browser-artifacts/${name}`;
  }finally{
    try{if(created)await unlink(join(directory.access,temporary));}finally{await directory.fd.close();}
  }
}
