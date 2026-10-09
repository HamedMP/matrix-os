import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { collectSiteFiles } from '../../packages/gateway/src/sites/bundle.js';
import { validateSiteFields, verifySiteSignature } from '../../packages/gateway/src/sites/submission-validation.js';
import { SiteSubmissionRepository } from '../../packages/gateway/src/sites/submission-repository.js';
import { Kysely, sql } from 'kysely';
import { KyselyPGlite } from 'kysely-pglite';

describe('site production bundle', () => {
 let dir: string;
 beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'matrix-sites-')); await mkdir(join(dir,'dist')); await writeFile(join(dir,'dist/index.html'), '<html></html>'); });
 afterEach(async () => { await rm(dir,{recursive:true,force:true}); });
 it('collects only checked output', async () => { await writeFile(join(dir,'secret.env'),'private'); expect(await collectSiteFiles(dir,'dist')).toEqual([{path:'index.html',contentType:'text/html',body:Buffer.from('<html></html>').toString('base64')}]); });
 it('rejects root-absolute Vite asset URLs',async()=>{await writeFile(join(dir,'dist/index.html'),'<script src="/assets/app.js"></script>');await expect(collectSiteFiles(dir,'dist')).rejects.toThrow('App needs a public build');});
 it('rejects symbolic links, sources, secrets and escaped output', async () => {
   await symlink(join(dir,'secret.env'), join(dir,'dist/leak.txt')); await expect(collectSiteFiles(dir,'dist')).rejects.toThrow();
   await rm(join(dir,'dist/leak.txt')); await writeFile(join(dir,'dist/.env'),'secret'); await expect(collectSiteFiles(dir,'dist')).rejects.toThrow();
   await rm(join(dir,'dist/.env')); await writeFile(join(dir,'dist/source.ts'),'source'); await expect(collectSiteFiles(dir,'dist')).rejects.toThrow();
   await expect(collectSiteFiles(dir,'.')).rejects.toThrow(); await expect(collectSiteFiles(dir,'../')).rejects.toThrow();
 });
});
const form = {id:'rsvp',title:'RSVP',fields:{email:{type:'email' as const,required:true},guests:{type:'number' as const,required:false,min:1,max:5}}};
describe('site submission validation', () => {
 it('accepts only bounded declared fields', () => { expect(validateSiteFields(form,{email:'a@example.com',guests:2})).toEqual({email:'a@example.com',guests:2}); for (const fields of [{email:'bad'},{email:'a@example.com',admin:true},{email:'a@example.com',guests:99},{}]) expect(() => validateSiteFields(form,fields)).toThrow(); });
 it('verifies raw-body HMAC with bounded expiry', () => { const raw='{}',stamp=String(Date.now()); const signature=createHmac('sha256','token').update(stamp+'.'+raw).digest('hex'); expect(verifySiteSignature(raw,stamp,signature,'token')).toBe(true); expect(verifySiteSignature('{ }',stamp,signature,'token')).toBe(false); expect(verifySiteSignature(raw,String(Date.now()-60000),signature,'token')).toBe(false); expect(verifySiteSignature(raw,stamp,signature,undefined)).toBe(false); });
});
describe('owner site submissions Postgres', () => {
 let db: Kysely<any>; let repo: SiteSubmissionRepository;
 beforeEach(async () => { const instance=await KyselyPGlite.create(); db=new Kysely({dialect:instance.dialect}); repo=new SiteSubmissionRepository(db); await repo.bootstrap(); });
 afterEach(async () => { await db.destroy(); });
 it('deduplicates durably, retains exact fields and scopes owner reads/deletes', async () => {
   const siteId=randomUUID(),versionId=randomUUID(); const input={siteId,appSlug:'event',versionId,formId:'rsvp',idempotencyKey:'1234567890123456',fields:{email:'a@example.com'}};
   await Promise.all([repo.submit(input),repo.submit(input)]); const result=await new SiteSubmissionRepository(db).list(siteId,'event',50,null); expect(result.items).toHaveLength(1); expect(result.items[0].fields).toEqual(input.fields);
   expect((await repo.list(siteId,'other',50,null)).items).toHaveLength(0); expect(await repo.delete(siteId,'other',result.items[0].id)).toBe(false); expect(await repo.delete(siteId,'event',result.items[0].id)).toBe(true); expect((await repo.list(siteId,'event',50,null)).items).toHaveLength(0);await repo.submit(input);expect((await repo.list(siteId,'event',50,null)).items).toHaveLength(0);
 });
 async function seed(siteId:string, day:number, exactTimestamp?:string){
  const key='submission-key-'+String(day).padStart(3,'0');
  await repo.submit({siteId,appSlug:'event',versionId:randomUUID(),formId:'rsvp',idempotencyKey:key,fields:{day}});
  await db.updateTable('_site_submissions').set({created_at:sql`${exactTimestamp??`2026-01-${String(day).padStart(2,'0')}T12:00:00.000000Z`}::timestamptz`}).where('site_id','=',siteId).where('idempotency_key','=',key).execute();
 }
 it('continues list/export without skipping after deleting an earlier page record',async()=>{
  const siteId=randomUUID();for(let day=1;day<=6;day++)await seed(siteId,day);
  const first=await repo.list(siteId,'event',2,null);expect(first.items.map(row=>row.fields.day)).toEqual([6,5]);
  await repo.delete(siteId,'event',first.items[0].id);
  const second=await repo.list(siteId,'event',2,first.nextCursor);expect(second.items.map(row=>row.fields.day)).toEqual([4,3]);
  const third=await repo.list(siteId,'event',2,second.nextCursor);expect(third.items.map(row=>row.fields.day)).toEqual([2,1]);expect(third.nextCursor).toBeNull();
 });
 it('does not repeat records when a newer submission arrives between pages',async()=>{
  const siteId=randomUUID();for(let day=1;day<=6;day++)await seed(siteId,day);
  const first=await repo.list(siteId,'event',2,null);await seed(siteId,7);
  const second=await repo.list(siteId,'event',2,first.nextCursor);expect(second.items.map(row=>row.fields.day)).toEqual([4,3]);
  const third=await repo.list(siteId,'event',2,second.nextCursor);
  const visited=[...first.items,...second.items,...third.items];expect(visited.map(row=>row.fields.day)).toEqual([6,5,4,3,2,1]);expect(new Set(visited.map(row=>row.id)).size).toBe(6);
 });
 it('preserves Postgres microsecond order and uses UUID to break exact timestamp ties',async()=>{
  const siteId=randomUUID();await seed(siteId,1,'2026-01-01T12:00:00.000100Z');await seed(siteId,2,'2026-01-01T12:00:00.000200Z');await seed(siteId,3,'2026-01-01T12:00:00.000300Z');await seed(siteId,4,'2026-01-01T12:00:00.000300Z');
  const all=await repo.list(siteId,'event',100,null);let cursor:string|null=null;const ids:string[]=[];
  do{const page=await repo.list(siteId,'event',1,cursor);ids.push(...page.items.map(row=>row.id));cursor=page.nextCursor;}while(cursor);
  expect(ids).toEqual(all.items.map(row=>row.id));expect(ids).toHaveLength(4);expect(new Set(ids).size).toBe(4);
 });

});
