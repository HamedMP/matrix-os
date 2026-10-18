import {AppStoreSlugSchema,AppStoreIdSchema} from '@matrix-os/contracts/app-store';
import type {AppStorePlatformClient} from './platform-client.js';
import {readStoreProvenance,installedAppPresent} from './provenance.js';
import {withStoreDirectory,atomicPrivateFile} from './private-state.js';import {isFsError} from '../app-gallery/pinned-directory.js';
interface ReceiptState {installed:Record<string,string>;absent:Record<string,string>}
export function receiptAction(state:ReceiptState,listingSlug:string,versionId:string,present:boolean):'install'|'remove'|null{
 return present?(state.installed[listingSlug]===versionId?null:'install'):(state.absent[listingSlug]===versionId?null:'remove');
}
function versions(raw:unknown):Record<string,string>{if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>500)throw new Error('Invalid receipt state');const result:Record<string,string>={};for(const[key,value]of Object.entries(raw)){AppStoreSlugSchema.parse(key);result[key]=AppStoreIdSchema.parse(value);}return result;}
/** Caller holds the owner coordinator. Provenance itself is the durable install queue, independent of job TTL. */
export async function reconcileStoreReceipts(homePath:string,platform:AppStorePlatformClient,listingSlug?:string):Promise<void>{
 return withStoreDirectory(homePath,['install-receipts'],async directory=>{
  let state:ReceiptState={installed:{},absent:{}};try{const raw=JSON.parse((await directory.readFile('state.json',131_072)).toString('utf8')) as ReceiptState;state={installed:versions(raw.installed),absent:versions(raw.absent)};}catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}
  const installs=(await readStoreProvenance(homePath)).installs;let attempts=0;
  for(const record of installs){if(listingSlug&&record.listingSlug!==listingSlug)continue;const present=await installedAppPresent(homePath,record.appSlug);const action=receiptAction(state,record.listingSlug,record.versionId,present);if(!action)continue;
   // Bound network work while holding the mutation coordinator; completed entries are skipped next pass.
   if(++attempts>4)break;
   if(action==='install'){await platform.recordInstall(record.listingSlug,record.versionId);state.installed[record.listingSlug]=record.versionId;delete state.absent[record.listingSlug];}
   else{await platform.removeInstall(record.listingSlug);state.absent[record.listingSlug]=record.versionId;delete state.installed[record.listingSlug];}
   // Persist after each successful idempotent call, including after job history expires.
   await atomicPrivateFile(directory,'state.json',Buffer.from(JSON.stringify(state)));
  }
 });
}
