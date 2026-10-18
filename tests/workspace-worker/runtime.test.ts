import { describe, expect, it, vi } from 'vitest';
import { RuntimeLifecycle } from '../../packages/workspace-worker/src/runtime/lifecycle.js';
import { runtimeDiagnostic } from '../../packages/workspace-worker/src/runtime/diagnostic.js';
import type { RuntimeDriver, RuntimeLease, RuntimeStore, RuntimeSummary } from '../../packages/workspace-worker/src/runtime/contracts.js';

function fixture() {
  let now = 0;
  let summary: RuntimeSummary = { state: 'running', placement: 'pooled', activeRuns: 0, generation: 1, idleSince: 0 };
  const leases: RuntimeLease[] = [];
  const store = {
    status: vi.fn(async () => summary), bindRuntime: vi.fn(), ownerForRuntime: vi.fn(),
    claim: vi.fn(async (job, time, duration, max) => {
      if (leases.some((l) => l.jobId === job.jobId)) return null;
      const lease = { ownerId: job.ownerId, jobId: job.jobId, generation: 1, expiresAt: time + duration, maxRunAt: time + max };
      leases.push(lease); summary.activeRuns++; return lease;
    }),
    active: vi.fn(async () => leases.filter((l) => l.expiresAt > now)),
    beginIdleInterrupt: vi.fn(async () => {summary={...summary,state:"interrupting",generation:2};return 2;}),
    beginInterrupt: vi.fn(async () => {summary={...summary,state:"interrupting",generation:2};return 2;}),
    heartbeat: vi.fn(async (lease, time, duration) => { lease.expiresAt = time + duration; return true; }),
    finish: vi.fn(async (lease) => { leases.splice(leases.indexOf(lease), 1); summary.activeRuns--; return true; }),
    recoverExpired: vi.fn(async () => undefined),
    beginCheckpoint: vi.fn(async () => leases.length ? null : 1),
    saveCheckpoint: vi.fn(async () => true), latestCheckpoint: vi.fn(async () => null),
    markSleeping: vi.fn(async () => true), confirmStopped: vi.fn(async () => true), fail: vi.fn(async () => undefined),
  } as unknown as RuntimeStore;
  const driver: RuntimeDriver = {
    running: true, start: vi.fn(async () => undefined), execute: vi.fn(async () => undefined),
    keepAlive: vi.fn(async () => undefined), checkpoint: vi.fn(async () => ({ generation: 1, createdAt: now, backup: {} })),
    stop: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
  };
  const schedule = vi.fn(async () => undefined);
  const lifecycle = new RuntimeLifecycle(store, driver, schedule, () => now,
    { leaseMs: 100, heartbeatMs: 20, idleGraceMs: 30, maxRunMs: 500 });
  return { lifecycle, store, driver, schedule, leases, tick: (n: number) => { now = n; }, personal: () => { summary = { ...summary, placement: 'personal' }; } };
}

describe('shared runtime active-work lifecycle', () => {
  it('retains tagged native diagnostics through interruption cleanup', async () => {
    const f=fixture(); const error=runtimeDiagnostic('execute',new Error('safe detail'),()=> 'safe detail');
    vi.mocked(f.driver.execute).mockRejectedValue(error);
    await expect(f.lifecycle.run({ownerId:'owner',jobId:'diag',type:'chat',message:'test'})).rejects.toThrow('"phase":"execute"');
  });
  it('keeps the runtime alive during model waits without any browser connection', async () => {
    const f = fixture(); let complete!: () => void;
    vi.mocked(f.driver.execute).mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const run = f.lifecycle.run({ ownerId: 'owner', jobId: 'job', type: 'chat', message: 'wait' });
    await vi.waitFor(() => expect(f.driver.execute).toHaveBeenCalled());
    f.tick(40); await f.lifecycle.alarm('owner');
    expect(f.store.heartbeat).toHaveBeenCalled(); expect(f.driver.keepAlive).toHaveBeenCalled();
    expect(f.driver.stop).not.toHaveBeenCalled(); complete(); await run;
  });
  it('does not stop while either of two active runs remains', async () => {
    const f = fixture(); f.leases.push({ownerId:'owner',jobId:'a',generation:1,expiresAt:100,maxRunAt:500}, {ownerId:'owner',jobId:'b',generation:1,expiresAt:100,maxRunAt:500});
    await f.lifecycle.alarm('owner'); expect(f.driver.stop).not.toHaveBeenCalled();
  });
  it('does not execute duplicate Queue deliveries', async () => {
    const f = fixture(); vi.mocked(f.store.claim).mockResolvedValue(null);
    await f.lifecycle.run({ownerId:'owner',jobId:'a',type:'wake'}); expect(f.driver.start).not.toHaveBeenCalled();
  });
  it('does not let stale callbacks destroy newer compute', async () => {
    const f = fixture(); f.leases.push({ownerId:'owner',jobId:'a',generation:1,expiresAt:100,maxRunAt:500});
    vi.mocked(f.store.heartbeat).mockResolvedValue(false);
    vi.mocked(f.store.beginInterrupt).mockResolvedValue(null);
    await f.lifecycle.alarm('owner'); expect(f.driver.cancel).not.toHaveBeenCalled();
  });
  it('checkpoints before stopping after idle grace', async () => {
    const f = fixture(); await f.lifecycle.alarm('owner');
    expect(f.driver.checkpoint).toHaveBeenCalled(); expect(f.store.saveCheckpoint).toHaveBeenCalled(); expect(f.driver.stop).toHaveBeenCalled();
    expect(vi.mocked(f.store.saveCheckpoint).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.driver.stop).mock.invocationCallOrder[0]);
  });
  it('fails closed when durable checkpoint publication fails', async () => {
    const f = fixture(); vi.mocked(f.store.saveCheckpoint).mockResolvedValue(false);
    await f.lifecycle.alarm('owner'); expect(f.driver.stop).not.toHaveBeenCalled(); expect(f.store.fail).toHaveBeenCalled();
  });
  it('bounds failed checkpoint retries while preserving the last acknowledged backup', async () => {
    const f=fixture(); f.tick(600); vi.mocked(f.store.saveCheckpoint).mockResolvedValue(false);
    await f.lifecycle.alarm('owner'); expect(f.store.beginIdleInterrupt).toHaveBeenCalledWith('owner',1,600);
    expect(f.driver.cancel).toHaveBeenCalled(); expect(f.store.markSleeping).not.toHaveBeenCalled();
  });
  it('never starts or destroys a personal VPS', async () => {
    const f = fixture(); f.personal(); await f.lifecycle.run({ownerId:'owner',jobId:'a',type:'wake'}); await f.lifecycle.alarm('owner');
    expect(f.driver.start).not.toHaveBeenCalled(); expect(f.driver.stop).not.toHaveBeenCalled();
  });
  it('marks a destroyed failed run as failed rather than ready', async () => {
    const f=fixture(); vi.mocked(f.driver.execute).mockRejectedValue(new Error('unavailable'));
    await expect(f.lifecycle.run({ownerId:'owner',jobId:'failed',type:'chat',message:'test'})).rejects.toThrow('interrupted');
    expect(f.store.confirmStopped).toHaveBeenCalledWith('owner',2,0);
  });
  it('does not let a late failed execution cancel the replacement generation', async () => {
    const f=fixture(); let reject!: (error:Error)=>void;
    vi.mocked(f.driver.execute).mockImplementation(()=>new Promise<void>((_resolve,rejectRun)=>{reject=rejectRun;}));
    const run=f.lifecycle.run({ownerId:'owner',jobId:'old',type:'chat',message:'wait'});
    await vi.waitFor(()=>expect(f.driver.execute).toHaveBeenCalled());
    vi.mocked(f.store.beginInterrupt).mockResolvedValue(null); // old generation already fenced in Postgres
    reject(new Error('old container exited'));
    await expect(run).rejects.toThrow('interrupted'); expect(f.driver.cancel).not.toHaveBeenCalled(); expect(f.store.fail).not.toHaveBeenCalled();
  });
  it('bounds active execution by maximum run deadline', async () => {
    const f = fixture(); f.leases.push({ownerId:'owner',jobId:'a',generation:1,expiresAt:1000,maxRunAt:500}); f.tick(501);
    const lease = f.leases[0]; await f.lifecycle.alarm('owner'); expect(f.driver.cancel).toHaveBeenCalled(); expect(f.store.beginInterrupt).toHaveBeenCalledWith(lease, 501);
  });
});

 describe('compute termination proof', () => {
  it('confirms stop only after native cancellation succeeds', async () => {
    const f=fixture(); vi.mocked(f.driver.execute).mockRejectedValue(new Error('failed'));
    await expect(f.lifecycle.run({ownerId:'owner',jobId:'proof',type:'wake'})).rejects.toThrow();
    expect(f.store.confirmStopped).toHaveBeenCalledWith('owner',2,0);
    expect(vi.mocked(f.driver.cancel).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.store.confirmStopped!).mock.invocationCallOrder[0]);
  });
  it('retains unknown holds and quarantine if destruction fails', async () => {
    const f=fixture(); vi.mocked(f.driver.execute).mockRejectedValue(new Error('failed'));
    vi.mocked(f.driver.cancel).mockRejectedValue(new Error('unknown termination'));
    await expect(f.lifecycle.run({ownerId:'owner',jobId:'unknown',type:'wake'})).rejects.toThrow();
    expect(f.store.confirmStopped).not.toHaveBeenCalled(); expect(f.store.fail).not.toHaveBeenCalled();
  });
 });

describe('overlapping termination recovery',()=>{
 it('does not write failed after confirmed settlement releases the generation',async()=>{
  const f=fixture();vi.mocked(f.driver.execute).mockRejectedValue(new Error('failed'));
  await expect(f.lifecycle.run({ownerId:'owner',jobId:'release',type:'wake'})).rejects.toThrow();
  expect(f.store.confirmStopped).toHaveBeenCalled();expect(f.store.fail).not.toHaveBeenCalled();
 });
 it('serializes destruction and rechecks the fence before a second callback',async()=>{
  const f=fixture();let summary={state:'interrupting',placement:'pooled',activeRuns:0,generation:2,idleSince:0} as RuntimeSummary;
  vi.mocked(f.store.status).mockImplementation(async()=>summary);
  let pending:Promise<void>|null=null;
  const gate=async(action:()=>Promise<void>)=>{const prior=pending??Promise.resolve();const task=prior.then(action);pending=task;try{await task;}finally{if(pending===task)pending=null;}};
  vi.mocked(f.store.confirmStopped!).mockImplementation(async()=>{summary={...summary,state:'running'};return true;});
  const create=()=>new RuntimeLifecycle(f.store,f.driver,f.schedule,()=>0,{leaseMs:100,heartbeatMs:20,idleGraceMs:30,maxRunMs:500},gate);
  await Promise.all([create().alarm('owner'),create().alarm('owner')]);
  expect(f.driver.cancel).toHaveBeenCalledOnce();expect(f.store.fail).not.toHaveBeenCalled();
 });
});
