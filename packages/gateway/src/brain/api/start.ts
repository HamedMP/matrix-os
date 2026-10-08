/**
 * Starts every Company Brain feature on the shared owner Kysely and returns the services bag. The core store comes
 * from startBrainProjectService; any failure there (a lock or statement deadline, a missing privilege, a clashing
 * older table) leaves the whole brain off (null: routes answer 503 and the agent gets no brain tool), logged by error
 * name and SQLSTATE, and never fails owner startup. Each feature then bootstraps on its own: a feature whose bootstrap
 * fails for any reason is logged the same way and left off (its routes answer 503 and its agent tools are dropped),
 * never failing the others. The project service is wrapped so a sync that wrote or deleted documents emits
 * documents_changed and an extraction that changed claims emits claims_changed. Bootstraps run in
 * BRAIN_BOOTSTRAP_ORDER: search, graph, the source kinds' tables (github, matrix, connectors, each on its own: a failed
 * group leaves only its kinds off), then brief. The /sources service gets one handler per kind whose tables exist,
 * syncs the git source through the wrapped project service and drops a removed source's derived rows before it
 * answers. Background runs (jobs/, spec 566) bootstrap brain_jobs last; their steps use the wrapped project service,
 * so a queued sync or extract emits the same change events as a request. The timers are the run worker (one per
 * gateway, for the schedule owner only, at most `concurrency` runs at once), the daily brief and a one-shot index
 * catch-up shortly after start (index-repair.ts); stopBrainServices stops the worker first.
 */
import type { Kysely } from "kysely";
import {
  bootstrapBrainBriefDatabase, createBrainBrief, createBrainBriefScheduler, createBrainBriefScopeLister,
} from "../brief/index.js";
import type {
  BrainBackgroundJob, BrainChangeHooks, BrainChangeListener, BrainIntegrationCaller, BrainIntegrationService,
  BrainProjectResolver, BrainServices, BrainSourceSyncLimits,
} from "../contracts.js";
import { bootstrapBrainGraphDatabase, createBrainGraph } from "../graph/index.js";
import { createBrainChangeHooks } from "../hooks.js";
import { createBrainImpactService } from "../impact/index.js";
import { BrainRepository, type BrainDatabase, type BrainScopeKey } from "../index.js";
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
   * OpenAI key of meaning search). Default: the schedule owner alone (none when there is no owner).
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

/** Emits only after the call succeeded and changed something; a failed scope lookup is logged, never thrown. */
async function announce(
  resolver: BrainProjectResolver, ownerId: string, projectRef: string,
  emit: (scope: BrainScopeKey, at: string) => void,
): Promise<void> {
  try {
    const { scope } = await resolver.resolve(ownerId, projectRef);
    emit(scope, new Date().toISOString());
  } catch (error: unknown) {
    console.warn("[brain] change event skipped; the next refresh repairs it:", errorName(error));
  }
}

/** The project service with change events: the sync and extract wrappers of the hooks contract. */
export function withBrainChangeEvents(
  project: BrainProjectService, resolver: BrainProjectResolver, hooks: BrainChangeHooks,
): BrainProjectService {
  return {
    ...project,
    async sync(ownerId, projectRef) {
      const view = await project.sync(ownerId, projectRef);
      if (view.counts.written > 0 || view.counts.deleted > 0) {
        await announce(resolver, ownerId, projectRef, (scope, at) => hooks.emit({
          type: "documents_changed", scope, sourceId: null, documentIds: null, at,
        }));
      }
      return view;
    },
    async extract(ownerId, projectRef, input, signal) {
      const view = await project.extract(ownerId, projectRef, input, signal);
      if (view.counts.claimsWritten > 0 || view.counts.claimsRemoved > 0) {
        await announce(resolver, ownerId, projectRef, (scope, at) => hooks.emit({
          type: "claims_changed", scope, extractor: view.extractor, documentIds: null, at,
        }));
      }
      return view;
    },
  };
}
