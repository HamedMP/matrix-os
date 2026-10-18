import {describe,it,expect,vi} from 'vitest';
import {createPublishDraftToolHandler} from '../../packages/kernel/src/tools/publish-draft.js';
describe('publish_app draft handoff',()=>{
 it('is absent without owner credentials',()=>expect(createPublishDraftToolHandler({env:{}})).toBeUndefined());
 it('prepares only a draft without AI consent or submission',async()=>{
  const fetcher=vi.fn(async()=>Response.json({id:'e53000b2-83ab-4c64-b8fc-ff176d733cb0',sourceSlug:'sample',sourceName:'Sample',status:'preparing',stage:'snapshot',ai:null,blockingFindings:0,createdAt:'2026-10-18',updatedAt:'2026-10-18',expiresAt:'2026-10-25'}));
  const handler=createPublishDraftToolHandler({env:{MATRIX_AUTH_TOKEN:'secret'},fetcher});const result=await handler!({app_name:'sample'});
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({app:'sample'});expect(result.content[0].text).toContain('Gallery');expect(result.content[0].text).not.toContain('matrix-os.com/store');
 });
});
