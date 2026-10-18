import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({state:undefined as Buffer|undefined,installs:[] as unknown[],present:new Map<string,boolean>(),save:vi.fn()}));
vi.mock('../../../packages/gateway/src/app-store/private-state.js',()=>({
 withStoreDirectory:async(_home:string,_parts:string[],run:(dir:unknown)=>unknown)=>run({readFile:async()=>{if(!mocks.state)throw Object.assign(new Error('Missing'),{code:'ENOENT'});return mocks.state;}}),
 atomicPrivateFile:async(_dir:unknown,_file:string,bytes:Buffer)=>{mocks.state=bytes;mocks.save(JSON.parse(bytes.toString()));},
}));
vi.mock('../../../packages/gateway/src/app-store/provenance.js',()=>({readStoreProvenance:async()=>({version:1,installs:mocks.installs}),installedAppPresent:async(_home:string,slug:string)=>mocks.present.get(slug)??true}));
import {reconcileStoreReceipts} from '../../../packages/gateway/src/app-store/install-receipts.js';
import {StoreError,type AppStorePlatformClient} from '../../../packages/gateway/src/app-store/platform-client.js';
const versionId='e53000b2-83ab-4c64-b8fc-ff176d733cb0';
const row=(listingSlug:string)=>({listingSlug,appSlug:listingSlug,versionId});
describe('receipt reconciliation fairness',()=>{
 beforeEach(()=>{mocks.state=undefined;mocks.installs=[];mocks.present.clear();mocks.save.mockClear();});
 it('preserves rejected receipts and completes later install and deletion receipts',async()=>{
  mocks.installs=[row('suspended'),row('healthy'),row('removed')];mocks.present.set('removed',false);
  const recordInstall=vi.fn(async(slug:string)=>{if(slug==='suspended')throw new StoreError('forbidden');});const removeInstall=vi.fn();
  const platform={recordInstall,removeInstall} as unknown as AppStorePlatformClient;
  await expect(reconcileStoreReceipts('/owner',platform)).resolves.toBeUndefined();
  expect(recordInstall.mock.calls.map(call=>call[0])).toEqual(['suspended','healthy']);expect(removeInstall).toHaveBeenCalledWith('removed');
  const saved=JSON.parse(mocks.state!.toString());expect(saved.installed).toEqual({healthy:versionId});expect(saved.absent).toEqual({removed:versionId});
  await reconcileStoreReceipts('/owner',platform);expect(recordInstall.mock.calls.map(call=>call[0])).toEqual(['suspended','healthy','suspended']);expect(removeInstall).toHaveBeenCalledOnce();
 });
 it('rotates a four-attempt budget past persistent failures',async()=>{
  mocks.installs=['one','two','three','four','five','six'].map(row);
  const recordInstall=vi.fn(async(slug:string)=>{if(slug!=='five'&&slug!=='six')throw new Error('offline');});
  const platform={recordInstall,removeInstall:vi.fn()} as unknown as AppStorePlatformClient;
  await reconcileStoreReceipts('/owner',platform);expect(recordInstall.mock.calls.map(call=>call[0])).toEqual(['one','two','three','four']);
  await reconcileStoreReceipts('/owner',platform);expect(recordInstall.mock.calls.slice(4).map(call=>call[0])).toEqual(['five','six','one','two']);
  const saved=JSON.parse(mocks.state!.toString());expect(saved.installed).toEqual({five:versionId,six:versionId});
 });
 it('keeps a scoped failed job pending instead of acknowledging its receipt',async()=>{
  mocks.installs=[row('sample')];const platform={recordInstall:vi.fn().mockRejectedValue(new StoreError('not_found')),removeInstall:vi.fn()} as unknown as AppStorePlatformClient;
  await expect(reconcileStoreReceipts('/owner',platform,'sample')).rejects.toMatchObject({code:'not_found'});
 });
});
