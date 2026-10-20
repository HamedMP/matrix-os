import { WorkspaceRuntime, type WorkspaceRuntimeEnvironment, type RuntimeConnection } from './runtime/durable-object.js';
import type { Kysely } from 'kysely';
import { PostgresComputeAdmissionStore, type AdmissionDatabase } from './data/compute-admission.js';
import type { ComputeBudgetDatabase } from './data/compute-budget.js';
import type { WorkspaceDatabase } from './data/repository.js';
import { runtimePolicyFromEnvironment } from './runtime/contracts.js';
import { admitWorkspaceChatMessage, createPostgresWorkspaceRepository } from './data/repository.js';
import { PostgresRuntimeStore } from './data/runtime-store.js';
import { R2WorkspaceFiles } from './data/files.js';
import { runWorkspaceFileCleanup } from './data/cleanup.js';
import { createWorkspaceRoutes } from './routes.js';
import { createWorkspaceAuthenticator } from './auth.js';
import { hydrateWorkspace, parseQueuedJob, publishRuntimeOutput } from './bridge.js';
import type { RuntimeJob } from './runtime/contracts.js';
import { safeRuntimeDiagnostic } from './runtime/diagnostic.js';
import { createPreviewCredentialResolver, type PreviewCredentialEnvironment } from './runtime/credentials.js';
export { DirectoryBackupGateway } from '@cloudflare/sandbox';

interface Environment extends WorkspaceRuntimeEnvironment, PreviewCredentialEnvironment {
  HYPERDRIVE: Hyperdrive;
  WORKSPACE_FILES: R2Bucket;
  WORKSPACE_JOBS: Queue<RuntimeJob>;
  WORKSPACE_RUNTIME: DurableObjectNamespace<MatrixWorkspaceRuntime>;
  PREVIEW_ENABLED?: string;
  PREVIEW_TOKEN?: string;
  PREVIEW_OWNER_ID?: string;
  CLERK_ISSUER?: string;
  CLERK_AUDIENCE?: string;
}
const authOptions = (env: Environment) => ({
  ...(env.CLERK_ISSUER && env.CLERK_AUDIENCE ? {clerk:{issuer:env.CLERK_ISSUER,audience:env.CLERK_AUDIENCE}} : {}),
  ...(env.PREVIEW_TOKEN && env.PREVIEW_OWNER_ID ? {previewBearer:{token:env.PREVIEW_TOKEN,ownerId:env.PREVIEW_OWNER_ID}} : {}),
});

const admissionStore = (db: Kysely<WorkspaceDatabase>) => new PostgresComputeAdmissionStore(
  db as unknown as Kysely<WorkspaceDatabase & ComputeBudgetDatabase & AdmissionDatabase>, (trx,owner,input)=>admitWorkspaceChatMessage(trx as unknown as Kysely<WorkspaceDatabase>,owner,input));

export class MatrixWorkspaceRuntime extends WorkspaceRuntime {
  protected async openRuntimeConnection(): Promise<RuntimeConnection> {
    const env = this.env as Environment;
    const repository = createPostgresWorkspaceRepository(env.HYPERDRIVE.connectionString);
    const files = new R2WorkspaceFiles(env.WORKSPACE_FILES);
    // Per-connection bounded snapshot; discarded when this job/alarm closes.
    const revisions = new Map<string, number>();
    return {
      store:new PostgresRuntimeStore(repository.db,admissionStore(repository.db).runtimeHooks()),
      resolveCredentials:createPreviewCredentialResolver(env),
      hydrate:owner => hydrateWorkspace(repository,files,owner,revisions),
      publishOutput:(lease,output) => publishRuntimeOutput(repository,files,lease,output,revisions),
      close:async () => {revisions.clear(); await repository.close();},
    };
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Environment): Promise<void> {
    const repository = createPostgresWorkspaceRepository(env.HYPERDRIVE.connectionString);
    try {
      const admission=admissionStore(repository.db);
      await admission.dispatch(async job=>{await env.WORKSPACE_JOBS.send(job);},Date.now(),10,env.PREVIEW_OWNER_ID);
      for (const owner of await admission.reconcileOwners(Date.now(),100)) {
        if (owner !== env.PREVIEW_OWNER_ID) continue;
        try { await env.WORKSPACE_RUNTIME.get(env.WORKSPACE_RUNTIME.idFromName(owner)).reconcile(owner); }
        catch (error) { console.error('[workspace-recovery] rearm deferred',safeRuntimeDiagnostic(error)); }
      }
      // Object collection stays hourly; compute recovery runs every minute.
      if (new Date(_event.scheduledTime).getUTCMinutes() === 17) await runWorkspaceFileCleanup(repository,new R2WorkspaceFiles(env.WORKSPACE_FILES));
    }
    finally { await repository.close(); }
  },
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (!env.HYPERDRIVE?.connectionString || !env.WORKSPACE_FILES || !env.WORKSPACE_JOBS || !env.WORKSPACE_RUNTIME) {
      return Response.json({error:'Workspace unavailable'},{status:503,headers:{'Cache-Control':'private, no-store'}});
    }
    const repository = createPostgresWorkspaceRepository(env.HYPERDRIVE.connectionString);
    const admission = admissionStore(repository.db);
    const runtime = new PostgresRuntimeStore(repository.db,admission.runtimeHooks());
    try {
      if (new URL(request.url).pathname === '/api/workspace/metrics') {
        const owner = env.PREVIEW_ENABLED === '1' ? await createWorkspaceAuthenticator(authOptions(env))(request) : null;
        if (!owner) return Response.json({error:'Unauthorized'},{status:401});
        const metrics = await env.WORKSPACE_RUNTIME.get(env.WORKSPACE_RUNTIME.idFromName(owner)).metrics();
        return Response.json(metrics,{headers:{'Cache-Control':'private, no-store'}});
      }
      const app = createWorkspaceRoutes({repository,files:new R2WorkspaceFiles(env.WORKSPACE_FILES),auth:authOptions(env),previewEnabled:env.PREVIEW_ENABLED === '1',runtime:{
        status:owner => runtime.status(owner),
        enqueue:async (owner,action) => {
          // The spike has one isolated kernel DB. Never share it across owners.
          if (owner !== env.PREVIEW_OWNER_ID) throw new Error('Compute preview is unavailable');
          const admitted = await admission.admit(owner,action,runtimePolicyFromEnvironment(env).maxRunMs,Date.now());
          // The committed outbox survives an ambiguous send. Scheduled dispatch retries it.
          try { await admission.dispatch(async job=>{await env.WORKSPACE_JOBS.send(job);},Date.now(),1,owner); }
          catch (error) { console.error('[workspace-outbox] delivery deferred',safeRuntimeDiagnostic(error)); }
          return {state:admitted.state,jobId:admitted.jobId,...(admitted.chatId ? {chatId:admitted.chatId} : {})};
        },
      }});
      return await app.fetch(request);
    } catch (error) {
      console.error('[workspace-worker] unavailable',error instanceof Error ? error.name : 'UnknownError');
      return Response.json({error:'Workspace unavailable'},{status:503});
    } finally { await repository.close(); }
  },
  async queue(batch: MessageBatch<RuntimeJob>, env: Environment): Promise<void> {
    const repository=createPostgresWorkspaceRepository(env.HYPERDRIVE.connectionString);
    const admission=admissionStore(repository.db);
    try { for (const message of batch.messages) {
      try {
        const job = parseQueuedJob(message.body);
        if (job.ownerId !== env.PREVIEW_OWNER_ID) throw new Error('Compute preview is unavailable');
        const admitted=await admission.validate(job);
        if (!admitted) { message.ack(); continue; }
        await env.WORKSPACE_RUNTIME.get(env.WORKSPACE_RUNTIME.idFromName(admitted.ownerId)).run(admitted);
        message.ack();
      } catch (error) {
        console.error('[workspace-queue] execution unavailable',safeRuntimeDiagnostic(error));
        message.retry({delaySeconds:60});
      }
    } } finally { await repository.close(); }
  },
} satisfies ExportedHandler<Environment, RuntimeJob>;
