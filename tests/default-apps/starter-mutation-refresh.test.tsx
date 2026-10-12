// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, renderHook, act, waitFor} from '@testing-library/react';
import {useRecords} from '../../home/app-templates/connected-starter/src/useRecords';
import type {Database,OwnerRecord} from '../../home/app-templates/connected-starter/src/types';
afterEach(()=>{cleanup();delete window.MatrixOS;vi.restoreAllMocks();});
const record=(id:string):OwnerRecord=>({id,fields:{title:id},accounts:[],sources:[],manualFields:[],scope:'personal',updatedAt:'2026-10-06'});
const row=(id:string)=>({id,payload:record(id)});
it('refreshes after a save during initial discovery without hiding existing records',async()=>{
 let old!: (v:unknown[])=>void; const pending=new Promise<unknown[]>(resolve=>{old=resolve;});
 const find=vi.fn().mockReturnValueOnce(pending).mockResolvedValue([row('new'),row('existing')]);
 window.MatrixOS={db:{find,insert:async()=>({id:'new'})} as unknown as Database};
 const {result}=renderHook(useRecords);
 await act(async()=>{await result.current.save(record('new'));});
 await waitFor(()=>expect(result.current.records.map(r=>r.id)).toEqual(['new','existing']));
 await act(async()=>{old([row('stale')]);});
 expect(result.current.records.map(r=>r.id)).toEqual(['new','existing']);
});
it('caps confirmed optimistic saves and marks incomplete coverage',async()=>{
 const initial=Array.from({length:1000},(_,i)=>row(String(i)));
 let held!: (v:unknown[])=>void;
 const find=vi.fn().mockImplementation((_t:unknown,q:{offset:number})=>q.offset<1000?Promise.resolve(initial.slice(q.offset,q.offset+500)):Promise.resolve([]));
 window.MatrixOS={db:{find,insert:async()=>({id:'new'})} as unknown as Database};
 const {result}=renderHook(useRecords);await waitFor(()=>expect(result.current.records).toHaveLength(1000));
 find.mockImplementation(()=>new Promise(resolve=>{held=resolve;}));
 await act(async()=>{await result.current.save(record('new'));});
 expect(result.current.records).toHaveLength(1000);expect(result.current.limited).toBe(true);
 await act(async()=>{held([]);});
});
it('keeps the confirmed record visible when the follow-up discovery fails',async()=>{
 const find=vi.fn().mockResolvedValueOnce([row('existing')]).mockRejectedValue(new Error('offline'));
 vi.spyOn(console,'error').mockImplementation(()=>{});
 window.MatrixOS={db:{find,insert:async()=>({id:'new'})} as unknown as Database};
 const {result}=renderHook(useRecords);await waitFor(()=>expect(result.current.records).toHaveLength(1));
 await act(async()=>{await result.current.save(record('new'));});
 await waitFor(()=>expect(result.current.error).toContain('could not be loaded'));
 expect(result.current.records.map(r=>r.id)).toEqual(['new','existing']);
});
