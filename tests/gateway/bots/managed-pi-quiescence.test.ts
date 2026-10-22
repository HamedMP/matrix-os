import { afterEach, expect, it, vi } from 'vitest';
import { deferred, fixture } from './managed-pi-quiescence-support.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
async function setup(...args: Parameters<typeof fixture>) { const f = await fixture(...args); cleanups.push(f.close); return f; }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

it('holds retention work until exact stop ACK and actual execution have both drained', async () => {
  const f = await setup(); await f.start(); const gate = deferred<void>(); f.stopGate(gate.promise);
  const work = vi.fn(async () => 'erased');
  const pending = f.runtime.withStoppedRun(f.identity, work);
  await vi.waitFor(() => expect(f.stopped).toHaveBeenCalledWith('runtime.stop'));
  expect(f.cancelInference).toHaveBeenCalledWith(f.binding); expect(work).not.toHaveBeenCalled();
  gate.resolve(); await flush(); expect(work).not.toHaveBeenCalled();
  f.complete(); expect(await pending).toBe('erased');
  expect(work).toHaveBeenCalledWith(expect.objectContaining({ ownerId:f.binding.ownerId,chatId:f.binding.chatId,runId:f.binding.runId,
    runtimeHandle:f.binding.runtimeHandle,executionGeneration:f.binding.executionGeneration,version:1 }));
});
it('generator return cannot finish while the underlying execution is still running', async () => {
  const f = await setup(); await f.start(); let returned = false;
  const pending = f.iterator.return(undefined).then(() => { returned = true; });
  await vi.waitFor(() => expect(f.cancelInference).toHaveBeenCalled()); await flush();
  expect(returned).toBe(false); f.complete(); await pending; expect(returned).toBe(true);
});
it.each(['ownerId','chatId','runId','runtimeHandle','executionGeneration'])('refuses substituted %s without stopping another run', async field => {
  const f = await setup(); await f.start();
  const work = vi.fn();
  await expect(f.runtime.withStoppedRun({ ...f.identity, [field]: 'wrong' }, work)).rejects.toThrow('Run stop unavailable');
  expect(f.stopped).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
});
it.each(['failure','handle','generation'])('withholds work for a %s supervisor stop reply using the real socket client', async kind => {
  const f = await setup(); await f.start();
  f.stopReply(requestId => kind === 'failure' ? { version:1,type:'runtime.result',requestId,ok:false,error:'runtime_unavailable' }
    : { version:1,type:'runtime.result',requestId,ok:true,state:'stopped',runtimeHandle:kind==='handle'?`runtime_${'b'.repeat(32)}`:f.binding.runtimeHandle,
      executionGeneration:kind==='generation'?'3':f.binding.executionGeneration });
  const work = vi.fn(); const pending = f.runtime.withStoppedRun(f.identity, work); f.complete();
  await expect(pending).rejects.toThrow('Run stop unavailable'); expect(work).not.toHaveBeenCalled();
  await expect(f.runtime.withStoppedRun(f.identity, work)).rejects.toThrow('Run stop unavailable');
});
it('rejects unavailable historical runs and expired terminal receipts rather than treating them as stopped', async () => {
  let now = 1_000; const f = await setup({ now: () => now, ttlMs: 100 });
  await expect(f.runtime.withStoppedRun(f.identity, vi.fn())).rejects.toThrow('Run stop unavailable');
  await f.start(); f.complete(); for await (const _event of f.iterator) { /* drain */ }
  now += 101;
  await expect(f.runtime.withStoppedRun(f.identity, vi.fn())).rejects.toThrow('Run stop unavailable');
});
it('requires durable stopped receipt capture before invoking retention work', async () => {
  const capture = deferred<void>(); const onStopped = vi.fn(async () => capture.promise);
  const f = await setup({ onStopped }); await f.start(); const work = vi.fn(async () => undefined);
  const pending = f.runtime.withStoppedRun(f.identity, work); f.complete();
  await vi.waitFor(() => expect(onStopped).toHaveBeenCalledOnce()); expect(work).not.toHaveBeenCalled();
  capture.resolve(); await pending; expect(work).toHaveBeenCalledOnce();
  expect(onStopped.mock.calls[0]![0]).toMatchObject({ ownerId:f.binding.ownerId,chatId:f.binding.chatId,runId:f.binding.runId,
    runtimeHandle:f.binding.runtimeHandle,executionGeneration:f.binding.executionGeneration });
});
it('fails closed on cancellation, drain timeout, and shutdown, without invoking retention work', async () => {
  const f = await setup({ timeoutMs: 30 }); await f.start(); const work = vi.fn();
  await expect(f.runtime.withStoppedRun(f.identity, work)).rejects.toThrow('Run stop unavailable'); expect(work).not.toHaveBeenCalled();
  f.complete(); await f.runtime.close();
  await expect(f.runtime.withStoppedRun(f.identity, work)).rejects.toThrow('Run stop unavailable');
});
it('cancellation before and during drain cannot run the retention callback', async () => {
  const f = await setup(); await f.start(); const cancelled = new AbortController(); cancelled.abort(); const work=vi.fn();
  await expect(f.runtime.withStoppedRun({...f.identity,signal:cancelled.signal},work)).rejects.toThrow('Run stop unavailable');
  expect(f.stopped).not.toHaveBeenCalled();
  const during=new AbortController(); const pending=f.runtime.withStoppedRun({...f.identity,signal:during.signal},work);
  await vi.waitFor(()=>expect(f.stopped).toHaveBeenCalled()); during.abort();
  await expect(pending).rejects.toThrow('Run stop unavailable'); expect(work).not.toHaveBeenCalled(); f.complete();
});
it('shutdown drains the actual execution and an already running retention callback', async () => {
  const f=await setup(); await f.start(); const work=deferred<void>(); const entered=vi.fn(async()=>work.promise);
  const pending=f.runtime.withStoppedRun(f.identity,entered); f.complete();
  await vi.waitFor(()=>expect(entered).toHaveBeenCalledOnce());
  let closed=false; const closing=f.runtime.close().then(()=>{closed=true;}); await flush(); expect(closed).toBe(false);
  const refusal=expect(pending).rejects.toThrow('Run stop unavailable'); work.resolve(); await closing; await refusal;
  expect(closed).toBe(true);
});
it('does not lose execution uncertainty when the output generator returns early', async () => {
  const f=await setup(); await f.start(); const returning=f.iterator.return(undefined); const work=vi.fn(async()=>undefined);
  const pending=f.runtime.withStoppedRun(f.identity,work); await flush(); expect(work).not.toHaveBeenCalled();
  f.complete(); await returning; await pending; expect(work).toHaveBeenCalledOnce();
});
it('denies retention work when durable receipt persistence fails and logs no private failure detail', async () => {
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  const f=await setup({onStopped:async()=>{throw new Error('PRIVATE_FAILURE_CANARY');}}); await f.start();
  const work=vi.fn(); const pending=f.runtime.withStoppedRun(f.identity,work); f.complete();
  await expect(pending).rejects.toThrow('Run stop unavailable'); expect(work).not.toHaveBeenCalled();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_FAILURE_CANARY');
});
it('shutdown cannot report success after an uncertain worker release', async()=>{
  const f=await setup(); await f.start();
  f.stopReply(requestId=>({version:1,type:'runtime.result',requestId,ok:false,error:'runtime_unavailable'}));
  const pending=f.runtime.withStoppedRun(f.identity,vi.fn()); f.complete();
  await expect(pending).rejects.toThrow('Run stop unavailable');
  await expect(f.runtime.close()).rejects.toThrow('Run stop unavailable');
});
it('shutdown waits for admission in flight and stops the runtime created after cancellation',async()=>{
 const f=await setup();const gate=deferred<void>();f.admissionGate(gate.promise);
 const starting=f.iterator.next();await vi.waitFor(()=>expect(f.admitted).toHaveBeenCalledOnce());
 let closed=false;const closing=f.runtime.close().then(()=>{closed=true;});await flush();expect(closed).toBe(false);
 gate.resolve();await closing;await starting;expect(f.stopped).toHaveBeenCalledWith('runtime.stop');expect(closed).toBe(true);
});
it('canonical cancel does not acknowledge delivered cancellation as a drained worker',async()=>{
 const f=await setup();await f.start();let acknowledged=false;
 const pending=f.runtime.adapter.cancel!({owner:{type:'personal',ownerId:f.binding.ownerId},chatId:f.binding.chatId,runId:f.binding.runId}).then(()=>{acknowledged=true;});
 await vi.waitFor(()=>expect(f.cancelInference).toHaveBeenCalled());await flush();expect(acknowledged).toBe(false);
 f.complete();await pending;expect(acknowledged).toBe(true);expect(f.stopped).toHaveBeenCalledWith('runtime.stop');
});
it('waits for cleanup already launched by Stop as well as execution-finally cleanup',async()=>{
 const firstClose=deferred<void>();const closeRun=vi.fn().mockImplementationOnce(()=>firstClose.promise).mockResolvedValue(undefined);
 const f=await setup({}, {open:async()=>undefined,closeRun} as unknown as Parameters<typeof fixture>[1]);await f.start();
 const work=vi.fn(async()=>undefined);const pending=f.runtime.withStoppedRun(f.identity,work);f.complete();
 await vi.waitFor(()=>expect(closeRun).toHaveBeenCalledTimes(2));await flush();
 try{expect(work).not.toHaveBeenCalled();}finally{firstClose.resolve();await pending;}
});
