import {describe,it,expect,vi} from 'vitest';
import {createAppStorePlatformClient} from '../../../packages/gateway/src/app-store/platform-client.js';
describe('authenticated store client',()=>{
 it('maps only an authoritative missing owner submission to null',async()=>{
  const versionId='11111111-1111-4111-8111-111111111111';const fetcher=vi.fn(async()=>Response.json({error:'not_found'},{status:404}));
  const client=createAppStorePlatformClient({platformUrl:'https://platform.test',handle:'owner',token:'secret',fetcher});
  await expect(client.submission(versionId)).resolves.toBeNull();expect(fetcher.mock.calls[0]).toMatchObject([`https://platform.test/internal/containers/owner/app-store/submissions/${versionId}`,{headers:{authorization:'Bearer secret'},redirect:'error'}]);
  fetcher.mockResolvedValueOnce(Response.json({error:'unavailable'},{status:503}));await expect(client.submission(versionId)).rejects.toMatchObject({code:'unavailable'});
  fetcher.mockResolvedValueOnce(Response.json({error:'forbidden'},{status:403}));await expect(client.submission(versionId)).rejects.toMatchObject({code:'forbidden'});
  fetcher.mockResolvedValueOnce(Response.json({error:'not_found'},{status:500}));await expect(client.submission(versionId)).rejects.toMatchObject({code:'not_found'});
  fetcher.mockResolvedValueOnce(Response.json(null));await expect(client.submission(versionId)).rejects.toMatchObject({code:'unavailable'});
 });
 it('reconciles uninstalls through the authenticated mutation and propagates retryable failures',async()=>{
  const fetcher=vi.fn(async()=>Response.json({installed:false,versionId:null,installCount:1,activeInstallCount:0}));
  const client=createAppStorePlatformClient({platformUrl:'https://platform.test',handle:'owner',token:'secret',fetcher});
  await expect(client.removeInstall('garden')).resolves.toBeUndefined();
  expect(fetcher.mock.calls[0]).toMatchObject(['https://platform.test/internal/containers/owner/app-store/listings/garden/install',{method:'DELETE',headers:{authorization:'Bearer secret'},redirect:'error'}]);
  fetcher.mockResolvedValueOnce(Response.json({error:'unavailable'},{status:503}));
  await expect(client.removeInstall('garden')).rejects.toMatchObject({code:'unavailable'});
 });
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

it('pages owner submissions through a bounded opaque cursor',async()=>{const fetcher=vi.fn(async()=>Response.json({submissions:[],listings:[]}));const client=createAppStorePlatformClient({platformUrl:'https://platform.test',handle:'owner',token:'fixture',fetcher});await client.submissions('owner_page-2');expect(fetcher.mock.calls[0][0]).toContain('submissions?cursor=owner_page-2');expect(()=>client.submissions('../invalid')).toThrow();});
it('reads full reviewer source text within its escaped JSON budget',async()=>{const text='\u0001'.repeat(512*1024);const client=createAppStorePlatformClient({platformUrl:'https://platform.test',handle:'owner',token:'fixture',fetcher:async()=>Response.json({path:'src/example.ts',text,size:text.length,binary:false,truncated:false})});expect((await client.reviewFile('11111111-1111-4111-8111-111111111111',{path:'src/example.ts'})).text).toBe(text);});
