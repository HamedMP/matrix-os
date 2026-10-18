import {describe,it,expect,vi} from 'vitest';import {collectSubmissionPages,retainSubmissionObservations,reconcileMissingSubmissionObservations} from '../../../packages/gateway/src/app-store/submission-pages.js';
describe('bounded submission pagination',()=>{
 it('reaches meaningful changes beyond the first100 submissions',async()=>{const page=vi.fn(async(cursor?:string)=>cursor==='second'?{submissions:[{versionId:'pending',status:'published'}]}:{submissions:Array.from({length:100},(_,n)=>({versionId:String(n),status:'published'})),nextCursor:'second'});const result=await collectSubmissionPages(page);expect(result.rows).toContainEqual({versionId:'pending',status:'published'});expect(page.mock.calls).toEqual([[undefined],['second']]);});
 it('persists a bounded scan cursor and always refreshes the newest page while advancing old history',async()=>{const page=vi.fn(async(cursor?:string)=>({submissions:[{versionId:cursor??'head',status:'in_review'}],nextCursor:cursor==='fourth'?undefined:cursor==='third'?'fourth':cursor==='second'?'third':'second'}));const first=await collectSubmissionPages(page);expect(page).toHaveBeenCalledTimes(3);expect(first.cursor).toBe('fourth');page.mockClear();const resumed=await collectSubmissionPages(page,first.cursor);expect(page.mock.calls).toEqual([[undefined],['fourth']]);expect(resumed.cursor).toBeUndefined();});
 it('keeps the newest status when pages overlap without duplicate notifications',async()=>{const result=await collectSubmissionPages(async(cursor?:string)=>cursor?{submissions:[{versionId:'same',status:'in_review'}]}:{submissions:[{versionId:'same',status:'published'}],nextCursor:'older'});expect(result.rows).toEqual([{versionId:'same',status:'published'}]);});
 it('keeps fresh changes when an older page fails and retries its cursor next time',async()=>{const result=await collectSubmissionPages(async(cursor?:string)=>{if(cursor)throw new Error('Unavailable');return{submissions:[{versionId:'head',status:'published'}],nextCursor:'retry'};});expect(result).toEqual({rows:[{versionId:'head',status:'published'}],cursor:'retry'});});
 it('rejects repeated upstream cursors instead of looping indefinitely',async()=>{await expect(collectSubmissionPages(async()=>({submissions:[],nextCursor:'same'}))).rejects.toThrow();});
 it('keeps unfinished observations ahead of historical terminal results within the hard cap',()=>{const previous=Object.fromEntries(Array.from({length:100},(_,n)=>['pending'+n,'in_review']));const rows=Array.from({length:500},(_,n)=>({versionId:'history'+n,status:'published'}));const next=retainSubmissionObservations(previous,rows);expect(Object.keys(next)).toHaveLength(500);for(let n=0;n<100;n++)expect(next['pending'+n]).toBe('in_review');});
 it('admits a new owner submission when historical observations already fill the cap',()=>{const previous=Object.fromEntries(Array.from({length:500},(_,n)=>['old'+n,'published']));const retained=retainSubmissionObservations(previous,[{versionId:'new',status:'submitting'}]);expect(Object.keys(retained)).toHaveLength(500);expect(retained.new).toBe('submitting');});
 it('refuses to silently evict unfinished submissions if their own hard limit is exceeded',()=>{expect(()=>retainSubmissionObservations(Object.fromEntries(Array.from({length:501},(_,n)=>['pending'+n,'in_review'])),[])).toThrow();});
});
describe('authoritative expired upload observations',()=>{
 it('removes only authoritatively missing upload intents and keeps review history and transport failures',async()=>{
  const previous={missing:'awaiting_upload',completed:'submitting',offline:'submitting',review:'in_review',published:'published'};
  const lookup=vi.fn(async(id:string)=>{if(id==='offline')throw new Error('offline');return id==='missing'?null:{versionId:id,status:'published'};});
  const result=await reconcileMissingSubmissionObservations(previous,[],lookup);
  expect(result.missing).toEqual(['missing']);expect(result.rows).toContainEqual({versionId:'completed',status:'published'});
  expect(lookup.mock.calls.map(call=>call[0])).not.toContain('review');expect(lookup.mock.calls.map(call=>call[0])).not.toContain('published');expect(result.missing).not.toContain('offline');
 });
 it('advances a four-lookup cursor even when the first four entries fail',async()=>{
  const previous=Object.fromEntries(['a','b','c','d','e','f'].map(id=>[id,'awaiting_upload']));const lookup=vi.fn(async()=>{throw new Error('offline');});
  const first=await reconcileMissingSubmissionObservations(previous,[],lookup);expect(lookup.mock.calls.map(call=>call[0])).toEqual(['a','b','c','d']);
  lookup.mockClear();await reconcileMissingSubmissionObservations(previous,[],lookup,first.cursor);expect(lookup.mock.calls.map(call=>call[0])).toEqual(['e','f','a','b']);
 });
 it('does not query a submission present in a successful page or silently evict pending reviews',async()=>{
  const lookup=vi.fn(async()=>null);const rows=[{versionId:'current',status:'awaiting_upload'}];const result=await reconcileMissingSubmissionObservations({current:'submitting',review:'in_review'},rows,lookup);
  expect(lookup).not.toHaveBeenCalled();expect(result.rows).toEqual(rows);expect(result.missing).toEqual([]);
 });
});
