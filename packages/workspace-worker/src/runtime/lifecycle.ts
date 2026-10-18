import {
  DEFAULT_RUNTIME_POLICY,
  type RuntimeDriver, type RuntimeJob, type RuntimeLease, type RuntimePolicy, type RuntimeStore,
} from './contracts.js';
import { runtimeDiagnostic, safeRuntimeDiagnostic } from './diagnostic.js';

/** Durable work, rather than a browser socket, owns the compute lease. */
export class RuntimeLifecycle {
  constructor(
    private readonly store: RuntimeStore,
    private readonly driver: RuntimeDriver,
    private readonly schedule: (at: number) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly policy: RuntimePolicy = DEFAULT_RUNTIME_POLICY,
    private readonly withTermination: (operation:()=>Promise<void>)=>Promise<void> = operation=>operation(),
  ) {
    if (policy.heartbeatMs <= 0 || policy.leaseMs < policy.heartbeatMs * 2
      || policy.maxRunMs > 30 * 60_000 || policy.maxRunMs <= 0 || policy.idleGraceMs < 0) {
      throw new Error('Invalid runtime policy');
    }
  }

  async run(job: RuntimeJob): Promise<{ accepted: boolean }> {
    if ((await this.store.status(job.ownerId)).placement === 'personal') return { accepted: false };
    const lease = await this.store.claim(job, this.now(), this.policy.leaseMs, this.policy.maxRunMs);
    if (!lease) return { accepted: false };
    await this.schedule(this.now() + this.policy.heartbeatMs);
    try {
      await this.driver.start(job.ownerId, await this.store.latestCheckpoint(job.ownerId), lease.generation);
      await this.driver.execute(job, lease);
      const finished = await this.store.finish(lease, 'completed', this.now());
      if (!finished) throw new Error('Runtime lease is no longer current');
      return { accepted: true };
    } catch (error: unknown) {
      console.error('[workspace-runtime] Execution interrupted', safeRuntimeDiagnostic(error));
      await this.interrupt(lease);
      throw runtimeDiagnostic('lifecycle',error,()=> 'Execution interrupted');
    } finally {
      await this.schedule(this.now() + this.policy.heartbeatMs);
    }
  }

  private async interrupt(lease: RuntimeLease): Promise<void> {
    const generation = await this.store.beginInterrupt(lease,this.now());
    if (generation === null) return;
    await this.terminate(lease.ownerId,generation,lease);
  }

  private async terminate(ownerId:string,generation:number,lease?:RuntimeLease):Promise<void> {
    await this.withTermination(async()=>{
      // A previous callback may already have released this generation. Recheck
      // under the DO's shared termination gate before touching native compute.
      const current=await this.store.status(ownerId);
      if(current.placement !== 'pooled' || current.state !== 'interrupting' || current.generation !== generation) return;
      const now=this.now();
      await this.driver.cancel(lease ?? {ownerId,jobId:'recovery',generation,expiresAt:now,maxRunAt:now});
      if(this.store.confirmStopped) await this.store.confirmStopped(ownerId,generation,this.now());
      else await this.store.fail(ownerId,generation);
    });
  }

  async alarm(ownerId: string): Promise<void> {
    const summary = await this.store.status(ownerId);
    if (summary.placement === 'personal') return;
    const now = this.now();
    if (summary.state === 'interrupting') {
      try { await this.terminate(ownerId,summary.generation); }
      finally { await this.schedule(now + this.policy.heartbeatMs); }
      return;
    }
    const active = await this.store.active(ownerId, now);
    let remaining = 0;
    for (const lease of active) {
      if (lease.expiresAt <= now || lease.maxRunAt <= now
        || !await this.store.heartbeat(lease, now, this.policy.leaseMs)) {
        await this.interrupt(lease);
      } else {
        remaining++;
      }
    }
    await this.store.recoverExpired(ownerId, now);
    if ((await this.store.status(ownerId)).state === 'interrupting') {
      await this.schedule(now + this.policy.heartbeatMs);
      return;
    }
    if (remaining) {
      await this.driver.keepAlive();
      await this.schedule(now + this.policy.heartbeatMs);
      return;
    }
    if (!this.driver.running) {
      if (summary.state !== 'sleeping') {
        const current = await this.store.status(ownerId);
        await this.store.fail(ownerId, current.generation);
      }
      return;
    }
    const generation = await this.store.beginCheckpoint(ownerId, now, this.policy.idleGraceMs);
    if (generation === null) {
      await this.driver.keepAlive();
      await this.schedule(now + this.policy.heartbeatMs);
      return;
    }
    try {
      const checkpoint = await this.driver.checkpoint(ownerId, generation);
      if (!await this.store.saveCheckpoint(ownerId, checkpoint)) throw new Error('Checkpoint fence rejected');
      await this.driver.stop();
      if (!await this.store.markSleeping(ownerId, generation)) throw new Error('Sleep fence rejected');
    } catch (error: unknown) {
      console.error('[workspace-runtime] Checkpoint failed', error instanceof Error ? error.name : 'UnknownError');
      await this.store.fail(ownerId, generation);
      // Retry only within a durable idle-age budget. Last acknowledged tasks have
      // already been checkpointed; exhaustion interrupts rather than claiming save.
      const retryMs = Math.min(this.policy.maxRunMs,120_000);
      if (summary.idleSince !== null && now - summary.idleSince >= retryMs) {
        const nextGeneration = await this.store.beginIdleInterrupt(ownerId,generation,now);
        if (nextGeneration !== null) {
          await this.terminate(ownerId,nextGeneration);
        }
      } else { await this.driver.keepAlive(); }
      await this.schedule(now + this.policy.heartbeatMs);
    }
  }
}
