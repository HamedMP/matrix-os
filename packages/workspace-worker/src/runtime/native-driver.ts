import { DirectoryBackup, type DirectoryBackupRecord } from '@cloudflare/sandbox';
import type { RuntimeCheckpoint, RuntimeDriver, RuntimeJob, RuntimeLease, RuntimeExecutionControl } from './contracts.js';
import { runtimeDiagnostic } from './diagnostic.js';
import { resolveRuntimeCredentials, type RuntimeCredentialResolver, type RuntimeCredentials } from './credentials.js';

export interface NativeRuntimeEnvironment {
  RUNTIME_INSTANCE?: string;
}
export interface RuntimeOutput {
  text: string;
  files: Array<{ path: string; content: string }>;
}
const ROOT = '/opt/matrix';
const CONTROL = 'packages/workspace-worker/runtime/control.mjs';
const MAX_OUTPUT = 256_000;

/** Native ctx.container API only. Credentials never enter the image or backup. */
export class NativeRuntimeDriver implements RuntimeDriver {
  private executionEnv: Record<string, string> = {};
  private credentials?:RuntimeCredentials;
  private boundOwner?:string;
  private readonly instance:ReturnType<typeof runtimeInstance>;
  constructor(
    private readonly container: Container,
    private readonly backups: DirectoryBackup,
    env: NativeRuntimeEnvironment,
    private readonly publish: (lease: RuntimeLease, output: RuntimeOutput) => Promise<void>,
    private readonly checkpointSaved: (checkpoint: RuntimeCheckpoint) => Promise<void>,
    private readonly hydrate: (ownerId: string) => Promise<RuntimeOutput['files']> = async () => [],
    private readonly resolveCredentials?:RuntimeCredentialResolver,
  ) {this.instance=runtimeInstance(env.RUNTIME_INSTANCE);}
  get running(): boolean { return this.container.running; }

  async start(ownerId: string, checkpoint: RuntimeCheckpoint | null, generation: number): Promise<void> {
    return this.withPhase('start',async()=>{
    if (this.boundOwner!==undefined && this.boundOwner!==ownerId) throw new Error('Runtime credentials unavailable');
    const credentials=await resolveRuntimeCredentials(this.resolveCredentials,{ownerId,generation});
    this.boundOwner=ownerId;
    this.credentials=credentials;
    this.executionEnv = {
      HOME: '/workspace/home', MATRIX_HOME: '/workspace/home', NODE_ENV: 'production',
      MATRIX_AUTH_TOKEN:credentials.authToken, ANTHROPIC_API_KEY:credentials.inferenceKey,
      DATABASE_URL:credentials.databaseUrl,
      // Shared compute leases cover one attached SDK task. Detached work needs
      // its own durable lease before it can survive task completion and sleep.
      // https://code.claude.com/docs/en/env-vars#variables
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1',
    };
    if (!this.container.running) {
      this.container.start({
        image: this.container.images.workspace, enableInternet: true,
        instance:this.instance,
      });
      // The 6h failsafe is separate from idle grace; explicit alarms checkpoint
      // before sleep. A checkpoint error must not trigger a short platform stop.
      await this.container.setInactivityTimeout(6 * 60 * 60_000);
      if (checkpoint) await this.withPhase('restore',()=>this.backups.restore(checkpoint.backup as DirectoryBackupRecord,{signal:AbortSignal.timeout(60_000)}));
    }
    const files = await this.withPhase('hydrate',()=>this.hydrate(ownerId));
    if (files.length > 100 || new TextEncoder().encode(JSON.stringify(files)).byteLength > 1_000_000) throw new Error('Workspace hydration limit exceeded');
    // A warm gateway still owns its previous process environment. Drain it
    // before every start so newly resolved credentials always take effect.
    await this.command('stop', undefined, 35_000);
    if (files.length) {
      await this.command('hydrate', JSON.stringify(files));
    }
    await this.command('start', undefined, 100_000);
    }).catch(error=>{this.clearCredentials();throw error;});
  }

  async execute(job: RuntimeJob, lease: RuntimeLease, control:RuntimeExecutionControl = operation=>operation()): Promise<void> {
    try {
    if (!this.credentials || this.credentials.ownerId!==job.ownerId || lease.ownerId!==job.ownerId
      || lease.jobId!==job.jobId
      || this.credentials.generation!==lease.generation || this.credentials.expiresAt<lease.maxRunAt
      || this.credentials.expiresAt<=Date.now() || lease.maxRunAt<=Date.now()) throw new Error('Runtime credentials unavailable');
    await this.command('execute', JSON.stringify(job), Math.max(1000, lease.maxRunAt - Date.now()),control);
    if (job.type === 'wake') return;
    await control(async()=>{
    // The spike admits one task per workspace. Stop writers before archiving.
    const checkpoint = await this.checkpoint(job.ownerId, lease.generation);
    await this.withPhase('checkpoint-publish',()=>this.checkpointSaved(checkpoint));
    const raw = await this.command('export');
    const output = await this.withPhase('export',async()=>JSON.parse(raw) as RuntimeOutput);
    await this.withPhase('publish',()=>this.publish(lease, output));
    });
    } finally {this.clearCredentials();}
  }
  async keepAlive(): Promise<void> {
    if (!this.container.running) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),10_000);
    try {
      const process = await this.container.exec(['true'], { stdout:'ignore', stderr:'ignore', user:'1000:1000', signal:controller.signal });
      void process.exitCode.then(() => clearTimeout(timer),() => clearTimeout(timer));
      if (await process.exitCode !== 0) throw new Error('Runtime keepalive failed');
    } finally { clearTimeout(timer); }
  }
  async checkpoint(_ownerId: string, generation: number): Promise<RuntimeCheckpoint> {
    try {
      await this.command('stop', undefined, 35_000);
      const backup = await this.backups.backup({ dir:'/workspace/home', exclude:['.cache/', 'system/heap-snapshots/', 'system/ai-providers/anthropic-key.json', 'system/ai-providers/.matrix-anthropic-key-staging/', '.claude.json', '.claude/.claude.json', '.claude/.credentials.json', '.claude/settings.json', '.claude/settings.local.json'], signal:AbortSignal.timeout(60_000) });
      return { backup, generation, createdAt:Date.now() };
    } catch (error: unknown) {
      const value = error as {name?:unknown;message?:unknown;code?:unknown;operation?:unknown;path?:unknown;detail?:unknown};
      console.error('[workspace-runtime] Native backup failed',this.redact(JSON.stringify({name:value?.name,message:value?.message,code:value?.code,operation:value?.operation,path:value?.path,detail:value?.detail})));
      throw this.diagnostic('checkpoint',error);
    } finally {this.clearCredentials();}
  }
  async stop(): Promise<void> {
    try {await this.withPhase('stop',()=>this.container.destroy());}
    finally {this.clearCredentials();}
  }
  async cancel(_lease: RuntimeLease): Promise<void> {
    try {await this.withPhase('stop',async()=>{
    // A fetch client exiting cannot abort gateway SDK descendants. Destroy the
    // isolated compute boundary to enforce the hard budget; saved work is in R2.
    // running=false can also precede native startup completion. Only a resolved
    // destroy call is positive termination proof for accounting and replacement.
    try { await this.container.destroy(); }
    catch (error: unknown) {
      // Keep the durable generation quarantined if explicit destruction is
      // unavailable; a platform timeout is never accounting proof.
      await this.container.setInactivityTimeout(1000);
      throw error;
    }
    });} finally {this.clearCredentials();}
  }
  async metrics(): Promise<unknown> {
    if (!this.running) return {running:false};
    return {running:true, ...JSON.parse(await this.command('metrics'))};
  }

  private redact(input: string): string {
    let text=input;
    for (const value of Object.values(this.executionEnv)) {
      if (typeof value === 'string' && value.length>=6) {
        text=text.split(value).join('[redacted]');
        text=text.split(JSON.stringify(value).slice(1,-1)).join('[redacted]');
      }
    }
    return text.replace(/sk-[A-Za-z0-9_-]+/g,'[redacted-key]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[redacted-database]').slice(-4096);
  }

  private clearCredentials():void {this.executionEnv={};this.credentials=undefined;}

  private diagnostic(phase:string,error:unknown):Error {
    const diagnostic=runtimeDiagnostic(phase,error,text=>this.redact(text));
    // Tagged upstream errors also pass through this driver's secret scrubber.
    return new Error(this.redact(diagnostic.message));
  }

  private async withPhase<T>(phase:string,action:()=>Promise<T>):Promise<T> {
    try {return await action();}
    catch(error:unknown) {throw this.diagnostic(phase,error);}
  }

  private async command(operation: string, input?: string, timeoutMs = 10_000, launch?:RuntimeExecutionControl): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const start=()=>{controller.signal.throwIfAborted();return this.container.exec(['node', CONTROL, operation], {
        cwd:ROOT, env:this.executionEnv, user:'1000:1000', signal:controller.signal,
        ...(input ? { stdin: new Blob([input]).stream() } : {}),
      });};
      const process=launch ? await launch(start) : await start();
      void process.exitCode.then(() => clearTimeout(timer), () => clearTimeout(timer));
      const result = await process.output();
      if (result.exitCode !== 0) {
        const detail = this.redact(new TextDecoder().decode(result.stderr));
        console.error('[workspace-runtime] Command failed',{operation,exitCode:result.exitCode,detail});
        throw new Error(`Runtime command failed (exit ${result.exitCode}): ${detail}`);
      }
      if (result.stdout.byteLength > MAX_OUTPUT) throw new Error('Runtime output limit exceeded');
      return new TextDecoder().decode(result.stdout);
    } catch(error:unknown) {throw this.diagnostic(operation,error);}
    finally { clearTimeout(timer); }
  }
}

function runtimeInstance(value?: string): 'lite' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4' {
  if (value === undefined) return 'standard-2';
  if (value === 'lite' || value === 'standard-1' || value === 'standard-2' || value === 'standard-3' || value === 'standard-4') return value;
  throw new Error('Invalid runtime instance');
}
