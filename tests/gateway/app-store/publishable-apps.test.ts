import {describe,it,expect,vi} from 'vitest';
vi.mock('../../../packages/gateway/src/app-runtime/app-index.js',()=>({listUniqueAppManifests:vi.fn(async()=>[
 {slug:'owner-app',relativePath:'owner-app',manifest:{name:'Owner app',runtime:'vite'}},
 {slug:'app-gallery',relativePath:'app-gallery',manifest:{name:'App Gallery',runtime:'vite'}},
 {slug:'community-app',relativePath:'community-app',manifest:{name:'Community',runtime:'vite'}},
 {slug:'nested-app',relativePath:'folder/nested-app',manifest:{name:'Nested',runtime:'vite'}},
])}));
vi.mock('../../../packages/gateway/src/app-store/provenance.js',()=>({readStoreProvenance:async()=>({version:1,installs:[{appSlug:'community-app'}]})}));
import {publishableStoreApps} from '../../../packages/gateway/src/app-store/publishable-apps.js';
describe('authoritative publishing eligibility',()=>{
 it('offers only supported owner app folders and disables bundled/community sources',async()=>{
  expect(await publishableStoreApps('/owner')).toEqual([
   {slug:'owner-app',name:'Owner app',eligible:true},
   {slug:'app-gallery',name:'App Gallery',eligible:false,reason:'bundled'},
   {slug:'community-app',name:'Community',eligible:false,reason:'community'},
  ]);
 });
});
