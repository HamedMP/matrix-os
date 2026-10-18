import {describe,it,expect,vi} from 'vitest';
import {createAppStorePlatformClient} from '../../../packages/gateway/src/app-store/platform-client.js';
describe('authenticated store client',()=>{
 it('validates status and never follows redirects',async()=>{
  const fetcher=vi.fn(async()=>Response.json({enabled:true,reviewer:false,signingKeys:[]}));
  const client=createAppStorePlatformClient({platformUrl:'https://platform.test',handle:'owner',token:'secret',fetcher});
  expect((await client.status()).enabled).toBe(true);
  expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error',headers:{authorization:'Bearer secret'}});
 });
 it('rejects unexpected platform payloads and credentials in URLs',async()=>{
  const client=createAppStorePlatformClient({platformUrl:'https://platform.test',handle:'owner',token:'secret',fetcher:async()=>Response.json({enabled:true,secret:'oops'})});
  await expect(client.status()).rejects.toMatchObject({code:'unavailable'});
  expect(()=>createAppStorePlatformClient({platformUrl:'https://user:password@platform.test',handle:'owner',token:'secret'})).toThrow();
 });
 it('maps only allowlisted platform errors',async()=>{
  const client=createAppStorePlatformClient({platformUrl:'https://platform.test',handle:'owner',token:'secret',fetcher:async()=>Response.json({error:'/private/key'},{status:500})});
  await expect(client.status()).rejects.toMatchObject({code:'unavailable'});
 });
});
