import { describe,it,expect,vi } from 'vitest';
import { createLocalStoreBuilder } from '../../../packages/gateway/src/app-store/local-builder.js';
describe('isolated local builds',()=>{
 it('fails closed before network or host execution when sandbox unavailable',async()=>{
  const fetcher=vi.fn(); const builder=createLocalStoreBuilder({homePath:'/unavailable',available:()=>false,fetcher});
  await expect(builder.build(new Map())).rejects.toMatchObject({code:'unavailable'});
  expect(fetcher).not.toHaveBeenCalled(); await builder.close();
 });
 it('rejects after shutdown',async()=>{
  const builder=createLocalStoreBuilder({homePath:'/unavailable',available:()=>false}); await builder.close();
  await expect(builder.build(new Map())).rejects.toMatchObject({code:'unavailable'});
 });
});
