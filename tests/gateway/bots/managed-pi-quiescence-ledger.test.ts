import { expect, it, vi } from 'vitest';
import { createManagedPiQuiescence } from '../../../packages/gateway/src/chat/managed-pi-quiescence.js';
const key={ownerId:'owner_one',chatId:'chat_one',runId:'run_one'};
const bound={...key,runtimeHandle:`runtime_${'a'.repeat(32)}`,executionGeneration:'2'};
const input={...key,signal:new AbortController().signal};
it('caps metadata, expires terminal records, and never promotes absent or expired state to stopped',async()=>{
 let now=1_000;const store=createManagedPiQuiescence({now:()=>now,maxRows:1,ttlMs:100});
 const tracked=store.track(key,async()=>undefined);tracked.bind(bound,async()=>undefined);await tracked.settle();
 expect(()=>store.track({...key,runId:'run_two'},async()=>undefined)).toThrow('Run stop unavailable');
 expect(await store.stopAndDrain(input)).toMatchObject(bound);
 now+=101;await expect(store.stopAndDrain(input)).rejects.toThrow('Run stop unavailable');
 const second={...key,runId:'run_two'};const next=store.track(second,async()=>undefined);next.bind({...bound,...second},async()=>undefined);await next.settle();
 await store.close();await expect(store.stopAndDrain({...input,...second})).rejects.toThrow('Run stop unavailable');
});
it('snapshots owner/run/tuple before waits and serializes retention callbacks for that record',async()=>{
 const store=createManagedPiQuiescence();const tracked=store.track(key,async()=>undefined);tracked.bind(bound,async()=>undefined);await tracked.settle();
 let finish!:()=>void;const held=new Promise<void>(resolve=>{finish=resolve;});const work=vi.fn(async()=>held);
 const mutable={...input};const pending=store.withStoppedRun(mutable,work);mutable.ownerId='owner_other';
 await vi.waitFor(()=>expect(work).toHaveBeenCalledOnce());
 expect(work.mock.calls[0]![0]).toMatchObject(key);
 await expect(store.withStoppedRun(input,vi.fn())).rejects.toThrow('Run stop unavailable');
 finish();await pending;await store.close();
});
it('cannot substitute a runtime tuple, reuse a tracked run, or record a foreign binding',async()=>{
 const store=createManagedPiQuiescence();const tracked=store.track(key,async()=>undefined);
 expect(()=>tracked.bind({...bound,ownerId:'owner_other'},async()=>undefined)).toThrow();
 tracked.bind(bound,async()=>undefined);await tracked.settle();
 expect(()=>store.track(key,async()=>undefined)).toThrow('Run stop unavailable');
 await expect(store.stopAndDrain({...input,executionGeneration:'3'})).rejects.toThrow('Run stop unavailable');
 await store.close();
});
