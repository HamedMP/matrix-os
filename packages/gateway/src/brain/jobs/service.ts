/**
 * Owner-scoped background runs of a project: resolve the project (the one shared resolver), then the job store.
 * Enqueue never runs work; it wakes the worker, which claims the job outside the request. Cancel records the stop and
 * tells this gateway's worker, which ends a run it holds at once.
 */
import type { BrainProjectResolver } from "../contracts.js";
import type { BrainScopeKey } from "../types.js";
import type { BrainJobStore } from "./store.js";
import { BrainJobError, type BrainJobKind, type BrainJobsService } from "./types.js";

export interface BrainJobsServiceDeps {
  readonly store: BrainJobStore;
  readonly resolver: BrainProjectResolver;
  /** Kinds this gateway has a step for; any other kind is job_kind_unavailable. */
  readonly kinds: readonly BrainJobKind[];
  /** Tells the worker a job was queued. */
  readonly wake: () => void;
  /** Tells this gateway's worker a running job was cancelled, so it stops at once; absent: at its next heartbeat. */
  readonly stop?: (scope: BrainScopeKey, jobId: string) => void;
  /**
   * The owner this gateway's worker runs jobs for. A request of any other owner is job_kind_unavailable, because
   * nothing would ever run it (the client then runs the work directly). Absent: every owner.
   */
  readonly workerOwnerId?: string;
}

export function createBrainJobsService(deps: BrainJobsServiceDeps): BrainJobsService {
  return {
    async enqueue(ownerId, projectRef, request) {
      const runnable = deps.workerOwnerId === undefined || deps.workerOwnerId === ownerId;
      if (!runnable || !deps.kinds.includes(request.kind)) throw new BrainJobError("job_kind_unavailable");
      const project = await deps.resolver.resolve(ownerId, projectRef);
      const { job, created } = await deps.store.enqueue(project.scope, project.projectId, request);
      if (created) deps.wake();
      return { job, deduped: !created };
    },
    async get(ownerId, projectRef, jobId) {
      const project = await deps.resolver.resolve(ownerId, projectRef);
      const job = await deps.store.get(project.scope, jobId);
      if (job === null) throw new BrainJobError("job_not_found");
      return job;
    },
    async list(ownerId, projectRef, limit) {
      const project = await deps.resolver.resolve(ownerId, projectRef);
      return { jobs: await deps.store.list(project.scope, limit) };
    },
    async cancel(ownerId, projectRef, jobId) {
      const project = await deps.resolver.resolve(ownerId, projectRef);
      const job = await deps.store.cancel(project.scope, jobId);
      if (job === null) throw new BrainJobError("job_not_found");
      if (job.status === "running" && job.cancelRequested) deps.stop?.(project.scope, jobId);
      return job;
    },
  };
}

/**
 * The jobs service of a brain whose background runs are off (brain_jobs failed to start) while the rest is on: nothing
 * can be queued, so every kind is job_kind_unavailable (the client then runs the work through the direct routes), and
 * there is no job to read or cancel.
 */
export const BRAIN_JOBS_OFF: BrainJobsService = {
  enqueue: () => Promise.reject(new BrainJobError("job_kind_unavailable")),
  get: () => Promise.reject(new BrainJobError("job_not_found")),
  list: () => Promise.resolve({ jobs: [] }),
  cancel: () => Promise.reject(new BrainJobError("job_not_found")),
};
