/**
 * Steps over the services that already run one bounded pass per call: git or source sync, claim extraction, the
 * search and graph refreshes, and the brief. A kind whose service is off has no step. A failed run whose code means
 * "busy" is thrown as a coded error, so the worker retries it; any other failed run stops the job with its code.
 * A model extraction is paid, so its run does one pass and ends (the summary's caughtUp says whether more is left).
 */
import type { BrainExtractView } from "../api/claims-types.js";
import type { BrainProjectService } from "../api/types.js";
import type { BrainBriefService, BrainDerivedIndex, BrainSourcesService } from "../contracts.js";
import {
  BRAIN_JOB_RETRY_CODES, type BrainJobStep, type BrainJobStepResult, type BrainJobSteps, type BrainJobSummary,
} from "./types.js";

export interface BrainJobStepServices {
  readonly project: BrainProjectService;
  readonly sources?: BrainSourcesService | null;
  readonly search?: BrainDerivedIndex | null;
  readonly graph?: BrainDerivedIndex | null;
  readonly brief?: BrainBriefService | null;
}

/** A busy answer from a service, retried by the worker. */
export class BrainJobBusyError extends Error {
  constructor(readonly code: string) {
    super("Company brain run is busy");
    this.name = "BrainJobBusyError";
  }
}

interface RunView {
  readonly status: "succeeded" | "partial" | "failed"; readonly errorCode: string | null;
  readonly caughtUp: boolean;
  /** The run's next action word (run_again, retry_later, connect_account, raise_budget, ...); absent reads as "". */
  readonly nextAction?: string;
}

/**
 * One sync or extract run as a step result. The summary keeps the run's status, error code and next action, so a
 * client can say what to do about a failed run whose code is a source or extraction code.
 */
export function brainRunStepResult(view: RunView, counts: BrainJobSummary): BrainJobStepResult {
  if (view.status === "failed" && view.errorCode !== null && BRAIN_JOB_RETRY_CODES.has(view.errorCode)) {
    throw new BrainJobBusyError(view.errorCode);
  }
  return {
    caughtUp: view.status !== "failed" && view.caughtUp,
    stopCode: view.status === "failed" ? (view.errorCode ?? "run_failed") : null,
    summary: { status: view.status, errorCode: view.errorCode, nextAction: view.nextAction ?? "", ...counts },
  };
}

/**
 * One bounded refresh. A refresh that says it is stuck (stopReason: the embeddings provider failed, the vector store
 * or the graph is full) stops the job with that code, so the worker never re-runs a step that cannot progress. A
 * search refresh with meaning search on adds the step's embedding tokens and cost to the summary.
 */
function refreshStep(index: BrainDerivedIndex): BrainJobStep {
  return async ({ scope, signal }) => {
    const result = await index.refresh(scope, {}, signal);
    const stopCode = result.caughtUp ? null : result.stopReason ?? null;
    const spend = result.embedding;
    return {
      caughtUp: result.caughtUp, stopCode,
      summary: { processed: result.processed, removed: result.removed, ...(stopCode === null ? {} : { stopCode }),
        ...(spend === undefined ? {} : { embeddingTokens: spend.tokens, embeddingCostMicroUsd: spend.costMicroUsd }) },
    };
  };
}

export function createBrainJobSteps(services: BrainJobStepServices): BrainJobSteps {
  const { project, sources, search, graph, brief } = services;
  const steps: Record<string, BrainJobStep> = {
    sync: async ({ ownerId, projectId, request, signal }) => {
      const sourceId = request.kind === "sync" ? request.sourceId : undefined;
      if (sourceId !== undefined && !sources) return { caughtUp: false, stopCode: "sources_unavailable", summary: {} };
      // A source run stops between pages on the signal; a git run ends on its own budget (it never calls out).
      const view = sourceId === undefined
        ? await project.sync(ownerId, projectId)
        : await sources!.sync(ownerId, projectId, sourceId, signal);
      return brainRunStepResult(view, view.counts as unknown as BrainJobSummary);
    },
    extract: async ({ ownerId, projectId, request, signal }) => {
      const extractor = request.kind === "extract" ? request.extractor : "rules";
      // The signal stops a model run's calls: cancel, the time cap and shutdown end the paid work, not just the wait.
      const view: BrainExtractView = await project.extract(ownerId, projectId, { extractor }, signal);
      const result = brainRunStepResult(view, { ...view.counts, caughtUp: view.caughtUp });
      // A model pass is paid: one pass per run, so a run never spends more than one request would.
      return extractor === "model" && result.stopCode === null ? { ...result, caughtUp: true } : result;
    },
  };
  if (search) steps.search_refresh = refreshStep(search);
  if (graph) steps.graph_refresh = refreshStep(graph);
  if (brief) {
    steps.brief = async ({ ownerId, projectId, request }) => {
      const window = request.kind === "brief" ? request.window : "day";
      const view = await brief.generateBrief(ownerId, projectId, { window });
      return {
        caughtUp: true, stopCode: null,
        summary: { date: view.date, window: view.window, stored: view.stored, truncated: view.truncated },
      };
    };
  }
  return steps;
}
