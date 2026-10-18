import {AppStoreProvenanceFileSchema,type AppStoreInstallRecord,type AppStoreProvenanceFile} from '@matrix-os/contracts/app-store-gateway';
import {pinDirectory,isFsError,type PinnedDirectory} from '../app-gallery/pinned-directory.js';
import {atomicPrivateFile} from './private-state.js';
async function directory<T>(homePath:string,create:boolean,operation:(directory:PinnedDirectory)=>Promise<T>):Promise<T>{
 let current=await pinDirectory(homePath);
 try{for(const part of ['system','app-store']){const next=create?await current.ensureChild(part):await current.child(part);await current.close();current=next;}return await operation(current);}finally{await current.close();}
}
export async function readStoreProvenance(homePath:string):Promise<AppStoreProvenanceFile>{
 // Non-Linux installations cannot be produced by the safe local builder.
 if(process.platform!=='linux')return {version:1,installs:[]};
 try{return await directory(homePath,false,async dir=>AppStoreProvenanceFileSchema.parse(JSON.parse((await dir.readFile('installs.json',1024*1024)).toString('utf8'))));}
 catch(error:unknown){if(isFsError(error,'ENOENT'))return {version:1,installs:[]};throw error;}
}
export async function writeStoreProvenance(homePath:string,value:AppStoreProvenanceFile):Promise<void>{
 const parsed=AppStoreProvenanceFileSchema.parse(value);await directory(homePath,true,dir=>atomicPrivateFile(dir,'installs.json',Buffer.from(JSON.stringify(parsed))));
}
export async function communityRecord(homePath:string,identity:string):Promise<AppStoreInstallRecord|null>{
 const slug=identity.replace(/^apps\//,'');if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))return null;
 const records=(await readStoreProvenance(homePath)).installs;const direct=records.find(row=>row.appSlug===slug);if(direct)return direct;if(!records.length)return null;
 const {resolveAppBySlug}=await import('../app-runtime/app-index.js');const {join}=await import('node:path');const resolved=await resolveAppBySlug(join(homePath,'apps'),slug);
 return resolved.ok?records.find(row=>row.appSlug===resolved.entry.relativePath)??null:null;
}

/** Constant-size discovery check; full source hashing is reserved for publication and recovery. */
export async function installedAppPresent(homePath:string,appSlug:string):Promise<boolean>{
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(appSlug))throw new Error('Invalid app identifier');
 const owner=await pinDirectory(homePath);let apps:PinnedDirectory|undefined,app:PinnedDirectory|undefined;
 try{apps=await owner.child('apps');app=await apps.child(appSlug);const bytes=await app.readFile('matrix.json',32_768);const raw:unknown=JSON.parse(bytes.toString('utf8'));return Boolean(raw&&typeof raw==='object'&&!Array.isArray(raw)&&'name'in raw&&typeof raw.name==='string'&&'runtime'in raw&&raw.runtime==='vite');}
 catch(error:unknown){if(isFsError(error,'ENOENT')||error instanceof SyntaxError)return false;throw error;}
 finally{await app?.close();await apps?.close();await owner.close();}
}
