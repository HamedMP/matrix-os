import {describe,it,expect} from 'vitest';import {receiptAction} from '../../../packages/gateway/src/app-store/install-receipts.js';
describe('receipt state independent of expiring install jobs',()=>{
 it('registers an existing provenance version when all job history has expired',()=>{expect(receiptAction({installed:{},absent:{}},'sample','v1',true)).toBe('install');});
 it('does not double count retries, updates versions, and reconciles reinstall after absence',()=>{
  expect(receiptAction({installed:{sample:'v1'},absent:{}},'sample','v1',true)).toBe(null);
  expect(receiptAction({installed:{sample:'v1'},absent:{}},'sample','v2',true)).toBe('install');
  expect(receiptAction({installed:{sample:'v1'},absent:{}},'sample','v1',false)).toBe('remove');
  expect(receiptAction({installed:{},absent:{sample:'v1'}},'sample','v1',false)).toBe(null);
  expect(receiptAction({installed:{},absent:{sample:'v1'}},'sample','v1',true)).toBe('install');
 });
});

import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {vi} from 'vitest';
import {writeStoreProvenance,installedAppPresent} from '../../../packages/gateway/src/app-store/provenance.js';import {reconcileStoreReceipts} from '../../../packages/gateway/src/app-store/install-receipts.js';
it.skipIf(process.platform!=='linux')('retries install after job history expires, then idempotently tracks deletion and reinstall',async()=>{
 const home=await mkdtemp(join(tmpdir(),'matrix-store-receipts-'));const recordInstall=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});const removeInstall=vi.fn().mockResolvedValue(undefined);const platform={recordInstall,removeInstall} as never;
 const record={listingSlug:'fixture',appSlug:'fixture',versionId:'e53000b2-83ab-4c64-b8fc-ff176d733cb0',version:'1.0.0',sourceSha256:'0'.repeat(64),distSha256:'0'.repeat(64),installedSourceSha256:'0'.repeat(64),toolchain:{nodeVersion:'v24.14.1',pnpmVersion:'10.33.4',policyDigest:'0'.repeat(64)},capabilities:{permissions:[],integrations:{required:[],optional:[]},tables:[]},installedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 try{const present=async()=>{await mkdir(join(home,'apps/fixture'),{recursive:true,mode:0o700});await writeFile(join(home,'apps/fixture/matrix.json'),JSON.stringify({name:'Fixture',runtime:'vite'}));};await present();await writeStoreProvenance(home,{version:1,installs:[record as never]});
 // No job directory exists: all successful job history may already have expired.
 expect(await installedAppPresent(home,'fixture')).toBe(true);await expect(reconcileStoreReceipts(home,platform)).rejects.toThrow('offline');await reconcileStoreReceipts(home,platform);await reconcileStoreReceipts(home,platform);expect(recordInstall).toHaveBeenCalledTimes(2);
 await rm(join(home,'apps/fixture'),{recursive:true});await reconcileStoreReceipts(home,platform);await reconcileStoreReceipts(home,platform);expect(removeInstall).toHaveBeenCalledOnce();
 await present();await reconcileStoreReceipts(home,platform);expect(recordInstall).toHaveBeenCalledTimes(3);
 }finally{await rm(home,{recursive:true,force:true});}
});
