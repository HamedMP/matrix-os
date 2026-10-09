/**
 * Starts every Company Brain feature on the shared owner Kysely and returns the services bag. The core store comes
 * from startBrainProjectService; any failure there (a lock or statement deadline, a missing privilege, a clashing
 * older table) leaves the whole brain off (null: routes answer 503 and the agent gets no brain tool), logged by error
 * name and SQLSTATE, and never fails owner startup. Each feature then bootstraps on its own: a feature whose bootstrap
 * fails for any reason is logged the same way and left off (its routes answer 503 and its agent tools are dropped),
 * never failing the others. The project service's git sync and extraction runners are wrapped so a run that wrote or
 * deleted documents emits documents_changed and one that changed claims emits claims_changed, even when it failed after
 * saving and its receipt (or run row) could not close. Bootstraps run in
 * BRAIN_BOOTSTRAP_ORDER: search, graph, the source kinds' tables (github, matrix, connectors, each on its own: a failed
 * group leaves only its kinds off), then brief. The /sources service gets one handler per kind whose tables exist,
 * syncs the git source through the project service and drops a removed source's derived rows before it answers.
 * Background runs (jobs/, spec 566) bootstrap brain_jobs last; their steps use the same project service, so a queued
 * sync or extract emits the same change events as a request. The timers are the run worker (one per
 * gateway, for the schedule owner only, at most `concurrency` runs at once), the daily brief and a one-shot index
 * catch-up shortly after start (index-repair.ts); stopBrainServices stops the worker first.
 */
import type { Kysely } from "kysely";
import {
  bootstrapBrainBriefDatabase, createBrainBrief, createBrainBriefScheduler, createBrainBriefScopeLister,
} from "../brief/index.js";
import { runBrainExtraction } from "../claims/index.js";
import type {
  BrainBackgroundJob, BrainChangeEvent, BrainChangeHooks, BrainChangeListener, BrainIntegrationCaller,
  BrainIntegrationService, BrainServices, BrainSourceSyncLimits,
} from "../contracts.js";
import { syncGitSource } from "../git/index.js";
import { bootstrapBrainGraphDatabase, createBrainGraph } from "../graph/index.js";
import { createBrainChangeHooks } from "../hooks.js";
import { createBrainImpactService } from "../impact/index.js";
import { BrainRepository, type BrainDatabase } from "../index.js";
import {
  BRAIN_JOB_WORKER_NAME, BrainJobStore, bootstrapBrainJobsDatabase, createBrainJobSteps, createBrainJobWorker,
  createBrainJobsService, type BrainJobKind, type BrainJobWorkerLimits,
} from "../jobs/index.js";
import {
  bootstrapBrainSearchDatabase, createBrainSearch, createBrainSearchEmbeddings,
} from "../search/index.js";
import {
  bootstrapBrainSourceTables, createBrainGitSourceSync, createBrainSourceHandlers, createBrainSourcesService,
  runBrainSourceSync,
} from "../sources/core/index.js";
import type { BrainMatrixChatReader, BrainMatrixNotesReader } from "../sources/matrix/index.js";
import { resolveBrainAgentOwnerId } from "./agent-tools.js";
import { eraseBrainProject } from "./erase.js";
import { createBrainIndexCatchUp, purgeBrainRemovedSource } from "./index-repair.js";
import { createBrainProjectResolver } from "./project-resolver.js";
import { startBrainProjectService } from "./service.js";
import {
  BRAIN_PROJECT_ID_PATTERN, brainProjectScope, type BrainProjectService, type BrainProjectServiceDeps,
} from "./types.js";

type BrainRunners = Required<Pick<BrainProjectServiceDeps, "sync" | "extract">>;

/** What the /sources kinds read through; every field is optional and a missing one turns its kinds off. */
export interface BrainSourcesStartOptions {
  /** The owner's integrations (late-bound in server.ts); absent: every integration call answers unavailable. */
  readonly integrations?: BrainIntegrationCaller;
  /** Whether an integration transport is bound (late-bound in server.ts); false: those kinds read not_configured. */
  readonly isConfigured?: () => boolean;
  /** Whether the owner has an account of a service (no provider call); absent: those kinds read not_configured. */
  readonly isConnected?: (ownerId: string, service: BrainIntegrationService) => Promise<boolean>;
  /** The owner's account labels of a service; present: connects pin one account and runs use only that one. */
  readonly accounts?: (ownerId: string, service: BrainIntegrationService) => Promise<readonly string[]>;
  /** Principals that may use MATRIX_BRAIN_GITHUB_TOKEN (the gateway's owner); absent: nobody. */
  readonly githubTokenOwnerIds?: readonly string[];
  /** The owner's Notes reader; absent: matrix_notes is off. */
  readonly notes?: BrainMatrixNotesReader | null;
  /** The owner's chat repository; absent: matrix_chat is off. */
  readonly chats?: BrainMatrixChatReader | null;
  readonly limits?: Partial<BrainSourceSyncLimits>;
}

export interface BrainServicesStartDeps extends Omit<BrainProjectServiceDeps, "repository" | "modelOwnerIds"> {
  /** The owner the daily brief schedule builds for; default resolveBrainAgentOwnerId(). Null: no schedule. */
  readonly scheduleOwnerId?: string | null;
  /**
   * The gateway owner's principals: only they may spend the owner's keys (the Anthropic key of model claims, the
   * OpenAI key of meaning search) and read its Notes and home (matrix_notes, matrix_files). Default: the schedule
   * owner alone (none when there is no owner).
   */
  readonly ownerIds?: readonly string[];
  readonly sources?: BrainSourcesStartOptions;
  /** Tests only: delay of the index catch-up after its job starts. */
  readonly catchUpDelayMs?: number;
  /** Tests only: the run worker's limits (each clamped to its ceiling); default BRAIN_JOB_WORKER_DEFAULTS. */
  readonly jobWorkerLimits?: Partial<BrainJobWorkerLimits>;
}

const UNAVAILABLE_INTEGRATIONS: BrainIntegrationCaller = { call: async () => ({ status: "unavailable" }) };

/** The services bag plus the erase step project deletion calls. */
export interface BrainServicesHandle extends BrainServices {
  /**
   * Erases the project's brain scope (eraseBrainProject: every core row, then every feature table's scope rows,
   * whether or not that feature started), then queues scope_erased, which drops change events still queued for the
   * scope. Throws on any failure, so the project deletion fails and is retried. A malformed project id is a no-op.
   */
  eraseProject(ownerId: string, projectId: string): Promise<void>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function sqlState(error: unknown): string | null {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** One feature's bootstrap and construction; any failure leaves only that feature off. Never throws. */
async function startFeature<T>(feature: string, start: () => Promise<T>): Promise<T | null> {
  try {
    return await start();
  } catch (error: unknown) {
    console.error(`[brain] ${feature} is off after its start failed:`, errorName(error), sqlState(error) ?? "");
    return null;
  }
}

/**
 * The git sync and extraction runners with change events, each for the run's own scope (ids null). A runner never
 * rejects and its counts cover every committed write, so a run that failed after saving (its receipt or run row left
 * unclosed, which the project service answers 503) is announced too.
 */
export function withBrainChangeEvents(runners: BrainRunners, emit: (event: BrainChangeEvent) => void): BrainRunners {
  return {
    async sync(options) {
      const result = await runners.sync(options);
      const { scope } = options;
      if (result.counts.written > 0 || result.counts.deleted > 0) {
        emit({ type: "documents_changed", scope, sourceId: null, documentIds: null, at: new Date().toISOString() });
      }
      return result;
    },
    async extract(options) {
      const result = await runners.extract(options);
      const { scope } = options, { extractor } = result;
      if (result.counts.claimsWritten > 0 || result.counts.claimsRemoved > 0) {
        emit({ type: "claims_changed", scope, extractor, documentIds: null, at: new Date().toISOString() });
      }
      return result;
    },
  };
}

export async function startBrainServices(
  kysely: Kysely<BrainDatabase>,
  deps: BrainServicesStartDeps,
): Promise<BrainServicesHandle | null> {
  const { scheduleOwnerId, sources: sourceOptions = {}, catchUpDelayMs, jobWorkerLimits, ownerIds: given, ...rest } = deps;
  const ownerId = scheduleOwnerId === undefined ? resolveBrainAgentOwnerId() : scheduleOwnerId;
  const ownerIds = given ?? (ownerId === null ? [] : [ownerId]);
  // The change bus, bound once its listeners exist; nothing runs a sync or an extraction before this returns.
  let bus: BrainChangeHooks | null = null;
  const runners = withBrainChangeEvents(
    { sync: rest.sync ?? syncGitSource, extract: rest.extract ?? runBrainExtraction }, (event) => bus?.emit(event),
  );
  const projectDeps = { ...rest, ...runners, modelOwnerIds: ownerIds };
  let core: BrainProjectService | null;
  try {
    core = await startBrainProjectService(kysely, projectDeps);
  } catch (error: unknown) {
    console.error("[brain] the brain is off after its core start failed:", errorName(error), sqlState(error) ?? "");
    return null;
  }
  if (core === null) return null;
  const project = core;
  const repository = new BrainRepository(kysely);
  const resolver = createBrainProjectResolver({ projects: deps.projects, homePath: deps.homePath });
  const search = await startFeature("search", async () => createBrainSearch({
    repository, resolver, capability: await bootstrapBrainSearchDatabase(kysely),
    embeddings: await createBrainSearchEmbeddings({ homePath: deps.homePath, env: process.env }),
    embeddingOwnerIds: ownerIds,
  }));
  const graph = await startFeature("graph", async () => {
    await bootstrapBrainGraphDatabase(kysely);
    return createBrainGraph({ repository, resolver });
  });
  // Never throws: each group that fails is logged and only its kinds are left out.
  const sourceTables = await bootstrapBrainSourceTables(kysely);
  const brief = await startFeature("brief", async () => {
    await bootstrapBrainBriefDatabase(kysely);
    return createBrainBrief({ repository, resolver });
  });
  const impact = createBrainImpactService({ repository, resolver });
  const listeners: BrainChangeListener[] = [
    ...(search === null ? [] : [search.index]), ...(graph === null ? [] : [graph.index]),
    ...(brief === null ? [] : [brief.listener]),
  ];
  const hooks = createBrainChangeHooks({ listeners });
  bus = hooks;
  // The same account lookup pins an account at connect (service) and checks it at run time (handlers).
  const { integrations = UNAVAILABLE_INTEGRATIONS, notes = null, chats = null, limits, ...seams } = sourceOptions;
  const sources = await startFeature("sources", async () => createBrainSourcesService({
    repository, resolver, runner: runBrainSourceSync, hooks, gitSync: createBrainGitSourceSync(project),
    handlers: createBrainSourceHandlers({
      kysely, integrations, homePath: deps.homePath, homeOwnerIds: ownerIds, notes, chats, ...seams,
    }, sourceTables),
    ...(seams.accounts === undefined ? {} : { accounts: seams.accounts }),
    ...(limits === undefined ? {} : { limits }),
    purgeRemoved: (scope, removed) => purgeBrainRemovedSource(kysely, listeners, scope, removed),
  }));
  const indexes = [...(search === null ? [] : [search.index]), ...(graph === null ? [] : [graph.index])];
  const runs = await startFeature("jobs", async () => {
    await bootstrapBrainJobsDatabase(kysely);
    const store = new BrainJobStore(kysely);
    const steps = createBrainJobSteps({
      project, sources, search: search?.index ?? null, graph: graph?.index ?? null, brief: brief?.service ?? null,
    });
    // No owner to run for: nothing is queued (every kind is unavailable), so clients run the work directly.
    const worker = ownerId === null ? null : createBrainJobWorker({
      store, ownerId, steps, ...(jobWorkerLimits === undefined ? {} : { limits: jobWorkerLimits }),
    });
    const service = createBrainJobsService({
      store, resolver, kinds: worker === null ? [] : Object.keys(steps) as BrainJobKind[],
      wake: () => worker?.wake(), ...(worker === null ? {} : { stop: worker.cancel }),
      ...(ownerId === null ? {} : { workerOwnerId: ownerId }),
    });
    return { service, worker };
  });
  const jobs = [
    ...(runs?.worker ? [runs.worker] : []),
    ...(ownerId === null || brief === null ? [] : [createBrainBriefScheduler({
      runner: brief.runner, ownerId, scopes: createBrainBriefScopeLister(kysely),
    })]),
    ...(indexes.length === 0 ? [] : [createBrainIndexCatchUp({
      db: kysely, indexes, ...(catchUpDelayMs === undefined ? {} : { startDelayMs: catchUpDelayMs }),
    })]),
  ];
  return {
    project,
    search: search?.service ?? null,
    graph: graph?.service ?? null,
    sources,
    brief: brief?.service ?? null,
    impact,
    runs: runs?.service ?? null,
    searchCapability: search?.service.capability() ?? null,
    indexes,
    hooks,
    jobs,
    async eraseProject(eraseOwnerId, projectId) {
      if (!BRAIN_PROJECT_ID_PATTERN.test(projectId)) return;
      await eraseBrainProject(kysely, eraseOwnerId, projectId);
      const scope = brainProjectScope(eraseOwnerId, projectId);
      hooks.emit({ type: "scope_erased", scope, at: new Date().toISOString() });
    },
  };
}

async function stopJobs(jobs: readonly BrainBackgroundJob[]): Promise<void> {
  const stopped = await Promise.allSettled(jobs.map((job) => job.stop()));
  for (const result of stopped) {
    if (result.status === "rejected") console.warn("[brain] job stop failed:", errorName(result.reason));
  }
}

/**
 * Gateway shutdown, before the owner Kysely is destroyed: stops the run worker first (it hands its runs back and its
 * steps call the other services), then the other jobs together, then drains the hooks. Never throws.
 */
export async function stopBrainServices(services: BrainServices | null, deadlineMs = 5_000): Promise<void> {
  if (services === null) return;
  const worker = services.jobs.filter((job) => job.name === BRAIN_JOB_WORKER_NAME);
  await stopJobs(worker);
  await stopJobs(services.jobs.filter((job) => job.name !== BRAIN_JOB_WORKER_NAME));
  await services.hooks.close(deadlineMs);
}
