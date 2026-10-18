import { DurableObject } from 'cloudflare:workers';
import { DirectoryBackup } from '@cloudflare/sandbox';
import { RuntimeLifecycle } from './lifecycle.js';
import { NativeRuntimeDriver, type NativeRuntimeEnvironment, type RuntimeOutput } from './native-driver.js';
import { runtimePolicyFromEnvironment, type RuntimeJob, type RuntimeLease, type RuntimeStore } from './contracts.js';
import { readRuntimeMetrics } from './memory-metrics.js';
export { DirectoryBackupGateway } from '@cloudflare/sandbox';

export interface RuntimeConnection {
  store: RuntimeStore;
  publishOutput(lease: RuntimeLease, output: RuntimeOutput): Promise<void>;
  hydrate?(ownerId: string): Promise<RuntimeOutput['files']>;
  close(): Promise<void>;
}
export interface WorkspaceRuntimeEnvironment extends NativeRuntimeEnvironment {
  RUNTIME_HEARTBEAT_MS?: string;
  RUNTIME_LEASE_MS?: string;
  RUNTIME_IDLE_GRACE_MS?: string;
  RUNTIME_MAX_RUN_MS?: string;
}

/** Parent composes Postgres/R2; no application state is persisted in DO storage. */
export abstract class WorkspaceRuntime extends DurableObject<WorkspaceRuntimeEnvironment> {
  protected abstract openRuntimeConnection(): Promise<RuntimeConnection>;
  constructor(ctx: DurableObjectState, env: WorkspaceRuntimeEnvironment) {
    super(ctx, env);
    if (!ctx.container) throw new Error('Workspace container is not configured');
    if (ctx.container.running) {
      void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(6 * 60 * 60_000));
    }
  }

  async run(job: RuntimeJob): Promise<{accepted:boolean}> {
    const { runtime, connection } = await this.connectRuntime();
    try {
      await connection.store.bindRuntime(this.ctx.id.toString(), job.ownerId);
      return await runtime.run(job);
    } finally { await connection.close(); }
  }

  async alarm(): Promise<void> {
    const { runtime, connection } = await this.connectRuntime();
    try {
      const ownerId = await connection.store.ownerForRuntime(this.ctx.id.toString());
      if (!ownerId) throw new Error('Runtime owner binding is unavailable');
      await runtime.alarm(ownerId);
    } finally { await connection.close(); }
  }

  /** Readiness reporting does not call start(). */
  async status(ownerId: string): Promise<unknown> {
    const connection = await this.openRuntimeConnection();
    try { return await connection.store.status(ownerId); }
    finally { await connection.close(); }
  }

  /** Internal RPC for spike measurements; never starts a stopped container. */
  async metrics(): Promise<unknown> {
    return readRuntimeMetrics(this.ctx.container!);
  }

  private async connectRuntime(): Promise<{runtime:RuntimeLifecycle; connection:RuntimeConnection}> {
    const connection = await this.openRuntimeConnection();
    const container = this.ctx.container!;
    const backupGateway = (this.ctx.exports as unknown as {DirectoryBackupGateway: ConstructorParameters<typeof DirectoryBackup>[1]}).DirectoryBackupGateway;
    const backups = new DirectoryBackup(container, backupGateway, { binding:'WORKSPACE_FILES', prefix:'runtime-checkpoints/' });
    const driver = new NativeRuntimeDriver(container, backups, this.env,
      (lease, output) => connection.publishOutput(lease, output),
      async (checkpoint) => {
        const ownerId = await connection.store.ownerForRuntime(this.ctx.id.toString());
        if (!ownerId || !await connection.store.saveCheckpoint(ownerId, checkpoint)) throw new Error('Checkpoint fence rejected');
      }, (ownerId) => connection.hydrate?.(ownerId) ?? Promise.resolve([]));
    const policy = runtimePolicyFromEnvironment(this.env);
    const runtime = new RuntimeLifecycle(connection.store, driver, (at) => this.ctx.storage.setAlarm(at), Date.now, policy);
    return {runtime,connection};
  }
}
