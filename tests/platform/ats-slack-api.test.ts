import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestAtsDb,destroyTestAtsDb} from './ats-db-test-helper.js';
import type {AtsDB} from '../../packages/platform/src/ats-db.js';
import {createAtsSlackTransport} from '../../packages/platform/src/ats-slack-api.js';
let db:AtsDB;beforeEach(async()=>{({db}=await createTestAtsDb());});afterEach(async()=>{vi.unstubAllGlobals();await destroyTestAtsDb(db);});
it('resumes a failed completion using the allocated and uploaded file',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({ok:true,upload_url:'https://files.slack.com/upload/one',file_id:'F123'})).mockResolvedValueOnce(new Response('ok')).mockResolvedValueOnce(Response.json({ok:false})).mockResolvedValueOnce(Response.json({ok:true}));vi.stubGlobal('fetch',fetcher);
 const transport=createAtsSlackTransport('secret','C12345678',db);const input={key:'attachment-1',filename:'cv.pdf',bytes:Buffer.from('file'),threadTs:'123.1'};
 await expect(transport.upload(input)).rejects.toThrow();await expect(transport.upload(input)).resolves.toEqual({fileId:'F123'});
 expect(fetcher.mock.calls.map(([url])=>String(url))).toEqual(['https://slack.com/api/files.getUploadURLExternal','https://files.slack.com/upload/one','https://slack.com/api/files.completeUploadExternal','https://slack.com/api/files.completeUploadExternal']);
 expect((await db.executor.selectFrom('ats_slack_uploads').selectAll().execute())[0].upload_url).toBeNull();
});
it('rejects an unexpected upload host before transmitting any file bytes',async()=>{
 const fetcher=vi.fn().mockResolvedValue(Response.json({ok:true,upload_url:'https://evil.example/upload',file_id:'F123'}));vi.stubGlobal('fetch',fetcher);
 await expect(createAtsSlackTransport('secret','C12345678',db).upload({key:'file',filename:'cv.pdf',bytes:Buffer.from('file'),threadTs:'123.1'})).rejects.toThrow('Unexpected');expect(fetcher).toHaveBeenCalledTimes(1);
});
it('honors rate limits without exposing credentials or provider errors',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:429,headers:{'retry-after':'120'}})));
 await expect(createAtsSlackTransport('secret','C12345678',db).post({key:'message',text:'test'})).rejects.toMatchObject({delayMs:120000});
});

it('form-encodes external upload metadata and completion while preserving file bytes',async()=>{
 const filename='Résumé & CV.pdf'; const bytes=Buffer.from('%PDF-test');
 const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
  const address=String(url);
  if(address==='https://files.slack.com/upload/one'){
   expect(new Uint8Array(init!.body as ArrayBuffer)).toEqual(new Uint8Array(bytes));
   return new Response('ok');
  }
  if(new Headers(init?.headers).get('content-type')!=='application/x-www-form-urlencoded;charset=UTF-8')
   return Response.json({ok:false,error:'invalid_arguments'});
  const form=new URLSearchParams(init!.body as string);
  if(address.endsWith('files.getUploadURLExternal')){
   expect(form.get('filename')).toBe(filename); expect(form.get('length')).toBe(String(bytes.length));
   return Response.json({ok:true,upload_url:'https://files.slack.com/upload/one',file_id:'F123'});
  }
  expect(JSON.parse(form.get('files')!)).toEqual([{id:'F123',title:filename}]);
  expect(form.get('channel_id')).toBe('C12345678'); expect(form.get('thread_ts')).toBe('123.1');
  return Response.json({ok:true});
 });
 vi.stubGlobal('fetch',fetcher);
 await expect(createAtsSlackTransport('secret','C12345678',db).upload({key:'unicode-file',filename,bytes,threadTs:'123.1'})).resolves.toEqual({fileId:'F123'});
 expect(fetcher).toHaveBeenCalledTimes(3);
});
it('keeps chat messages as JSON with plain text blocks',async()=>{
 const fetcher=vi.fn().mockResolvedValue(Response.json({ok:true,ts:'123.1'}));vi.stubGlobal('fetch',fetcher);
 await createAtsSlackTransport('secret','C12345678',db).post({key:'plain',text:'Candidate <@here>'});
 const [,init]=fetcher.mock.calls[0];
 expect(new Headers(init.headers).get('content-type')).toBe('application/json;charset=UTF-8');
 expect(JSON.parse(init.body)).toMatchObject({text:'Candidate <@here>',mrkdwn:false,blocks:[{type:'section',text:{type:'plain_text',text:'Candidate <@here>'}}]});
});
