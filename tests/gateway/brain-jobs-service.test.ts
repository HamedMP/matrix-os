import { describe, expect, it, vi } from "vitest";
import type { BrainProjectService } from "../../packages/gateway/src/brain/api/types.js";
import type {
  BrainBriefService, BrainDerivedIndex, BrainProjectResolver, BrainSourcesService,
} from "../../packages/gateway/src/brain/contracts.js";
import {
  BrainJobBusyError, BrainJobError, brainRunStepResult, createBrainJobSteps, createBrainJobsService,
  type BrainJobStepContext, type BrainJobStore, type BrainJobView,
} from "../../packages/gateway/src/brain/jobs/index.js";

const scope = { ownerId: "owner_s", scopeId: "personal:project:proj_s" };
const resolver: BrainProjectResolver = {
  homePath: "/home",
  resolve: vi.fn(async () => ({ projectId: "proj_s", slug: "s", name: "S", scope })),
  checkoutPath: vi.fn(async () => null),
};
const job = { jobId: `job_${"c".repeat(32)}` } as BrainJobView;

function fakeStore(overrides: Partial<Record<keyof BrainJobStore, unknown>> = {}): BrainJobStore {
  return {
    enqueue: vi.fn(async () => ({ job, created: true })),
    get: vi.fn(async () => job),
    list: vi.fn(async () => [job]),
    cancel: vi.fn(async () => job),
    ...overrides,
  } as unknown as BrainJobStore;
}

describe("brain jobs service", () => {
  it("resolves the project, queues and wakes the worker only for new jobs", async () => {
    const wake = vi.fn();
    const store = fakeStore();
    const service = createBrainJobsService({ store, resolver, kinds: ["sync", "brief"], wake });
    expect(await service.enqueue("owner_s", "s", { kind: "sync" })).toEqual({ job, deduped: false });
    expect(store.enqueue).toHaveBeenCalledWith(scope, "proj_s", { kind: "sync" });
    expect(wake).toHaveBeenCalledTimes(1);
    vi.mocked(store.enqueue).mockResolvedValueOnce({ job, created: false });
    expect(await service.enqueue("owner_s", "s", { kind: "sync" })).toEqual({ job, deduped: true });
    expect(wake).toHaveBeenCalledTimes(1);
    await expect(service.enqueue("owner_s", "s", { kind: "graph_refresh" }))
      .rejects.toEqual(new BrainJobError("job_kind_unavailable"));
    expect(await service.get("owner_s", "s", job.jobId)).toBe(job);
    expect(await service.list("owner_s", "s", 5)).toEqual({ jobs: [job] });
    expect(store.list).toHaveBeenCalledWith(scope, 5);
    expect(await service.cancel("owner_s", "s", job.jobId)).toBe(job);
  });

  it("queues only the worker owner's runs: another owner's request would never run", async () => {
    const store = fakeStore();
    const service = createBrainJobsService({
      store, resolver, kinds: ["sync"], wake: vi.fn(), workerOwnerId: "owner_s",
    });
    expect(await service.enqueue("owner_s", "s", { kind: "sync" })).toEqual({ job, deduped: false });
    await expect(service.enqueue("owner_t", "s", { kind: "sync" }))
      .rejects.toEqual(new BrainJobError("job_kind_unavailable"));
    expect(store.enqueue).toHaveBeenCalledTimes(1);
    // Reads still answer for the owner's own scope.
    expect(await service.list("owner_t", "s", 5)).toEqual({ jobs: [job] });
  });

  it("tells the worker at once when a running job is cancelled, never for a queued or finished one", async () => {
    const stop = vi.fn();
    const running = { ...job, status: "running", cancelRequested: true } as BrainJobView;
    const cancel = vi.fn(async () => running);
    const service = createBrainJobsService({ store: fakeStore({ cancel }), resolver, kinds: ["sync"], wake: vi.fn(), stop });
    expect(await service.cancel("owner_s", "s", job.jobId)).toBe(running);
    expect(stop).toHaveBeenCalledWith(scope, job.jobId);
    cancel.mockResolvedValueOnce({ ...job, status: "cancelled", cancelRequested: false } as BrainJobView);
    cancel.mockResolvedValueOnce({ ...job, status: "succeeded", cancelRequested: false } as BrainJobView);
    await service.cancel("owner_s", "s", job.jobId);
    await service.cancel("owner_s", "s", job.jobId);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("answers job_not_found for jobs outside the scope", async () => {
    const service = createBrainJobsService({
      store: fakeStore({ get: vi.fn(async () => null), cancel: vi.fn(async () => null) }),
      resolver, kinds: ["sync"], wake: vi.fn(),
    });
    await expect(service.get("owner_s", "s", job.jobId)).rejects.toEqual(new BrainJobError("job_not_found"));
    await expect(service.cancel("owner_s", "s", job.jobId)).rejects.toEqual(new BrainJobError("job_not_found"));
  });
});

const counts = { read: 2, written: 1, unchanged: 1, deleted: 0, failed: 0 };
const context = (request: BrainJobStepContext["request"]): BrainJobStepContext => ({
  ownerId: "owner_s", projectId: "proj_s", scope, request, signal: new AbortController().signal, step: 1,
});

describe("brain job steps", () => {
  it("maps run views to step results", () => {
    expect(brainRunStepResult({ status: "partial", errorCode: null, caughtUp: false }, { written: 1 })).toEqual({
      caughtUp: false, stopCode: null, summary: { status: "partial", errorCode: null, nextAction: "", written: 1 },
    });
    // The next action travels with the summary, so a client can word a failed run's source or extraction code.
    expect(brainRunStepResult({
      status: "failed", errorCode: "spend_cap_reached", caughtUp: false, nextAction: "raise_budget",
    }, {})).toEqual({
      caughtUp: false, stopCode: "spend_cap_reached",
      summary: { status: "failed", errorCode: "spend_cap_reached", nextAction: "raise_budget" },
    });
    expect(brainRunStepResult({ status: "succeeded", errorCode: null, caughtUp: true }, {}).caughtUp).toBe(true);
    expect(brainRunStepResult({ status: "failed", errorCode: "auth_failed", caughtUp: true }, {}))
      .toMatchObject({ caughtUp: false, stopCode: "auth_failed" });
    expect(brainRunStepResult({ status: "failed", errorCode: null, caughtUp: false }, {}).stopCode).toBe("run_failed");
    expect(() => brainRunStepResult({ status: "failed", errorCode: "sync_in_progress", caughtUp: false }, {}))
      .toThrow(BrainJobBusyError);
    try {
      brainRunStepResult({ status: "failed", errorCode: "extraction_in_progress", caughtUp: false }, {});
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "extraction_in_progress", name: "BrainJobBusyError" });
    }
  });

  it("runs git and source syncs, extraction, refreshes and the brief", async () => {
    const project = {
      sync: vi.fn(async () => ({ status: "succeeded", errorCode: null, caughtUp: true, counts })),
      extract: vi.fn(async () => ({ status: "partial", errorCode: null, caughtUp: false, counts: { claimsWritten: 4 } })),
    } as unknown as BrainProjectService;
    const sources = {
      sync: vi.fn(async () => ({ status: "partial", errorCode: null, caughtUp: false, counts })),
    } as unknown as BrainSourcesService;
    const index = (caughtUp: boolean) => ({
      refresh: vi.fn(async () => ({ processed: 3, removed: 1, caughtUp })),
    }) as unknown as BrainDerivedIndex;
    const search = index(true);
    const graph = index(false);
    const brief = {
      generateBrief: vi.fn(async () => ({ date: "2026-10-02", window: "week", stored: true, truncated: false })),
    } as unknown as BrainBriefService;
    const steps = createBrainJobSteps({ project, sources, search, graph, brief });
    expect(Object.keys(steps).sort()).toEqual(["brief", "extract", "graph_refresh", "search_refresh", "sync"]);
    expect(await steps.sync!(context({ kind: "sync" }))).toMatchObject({ caughtUp: true, summary: { written: 1 } });
    vi.mocked(project.sync).mockResolvedValueOnce({
      status: "failed", errorCode: "not_a_repository", nextAction: "fix_source", caughtUp: false, counts,
    } as never);
    expect(await steps.sync!(context({ kind: "sync" }))).toMatchObject({
      stopCode: "not_a_repository", summary: { errorCode: "not_a_repository", nextAction: "fix_source", read: 2 },
    });
    expect(project.sync).toHaveBeenCalledWith("owner_s", "proj_s");
    const sourceId = `src_${"d".repeat(32)}`;
    expect(await steps.sync!(context({ kind: "sync", sourceId }))).toMatchObject({ caughtUp: false, stopCode: null });
    expect(sources.sync).toHaveBeenCalledWith("owner_s", "proj_s", sourceId, expect.any(AbortSignal));
    expect(await steps.sync!(context({ kind: "graph_refresh" }))).toMatchObject({ caughtUp: true });
    expect(await steps.extract!(context({ kind: "extract", extractor: "model" })))
      .toMatchObject({ caughtUp: true, stopCode: null, summary: { claimsWritten: 4, caughtUp: false } });
    expect(project.extract).toHaveBeenCalledWith("owner_s", "proj_s", { extractor: "model" }, expect.any(AbortSignal));
    expect(await steps.extract!(context({ kind: "sync" }))).toMatchObject({ caughtUp: false, stopCode: null });
    expect(project.extract).toHaveBeenLastCalledWith("owner_s", "proj_s", { extractor: "rules" }, expect.any(AbortSignal));
    // The run's own signal reaches the paid work, so a cancel stops the model calls themselves.
    const stopper = new AbortController();
    await steps.extract!({ ...context({ kind: "extract", extractor: "model" }), signal: stopper.signal });
    expect(vi.mocked(project.extract).mock.lastCall?.[3]).toBe(stopper.signal);
    vi.mocked(project.extract).mockResolvedValueOnce({
      status: "failed", errorCode: "model_auth_failed", caughtUp: false, counts: {},
    } as never);
    expect(await steps.extract!(context({ kind: "extract", extractor: "model" })))
      .toMatchObject({ caughtUp: false, stopCode: "model_auth_failed" });
    expect(await steps.search_refresh!(context({ kind: "search_refresh" }))).toEqual({
      caughtUp: true, stopCode: null, summary: { processed: 3, removed: 1 },
    });
    expect(search.refresh).toHaveBeenCalledWith(scope, {}, expect.any(AbortSignal));
    // With meaning search on, the step's summary carries what that step spent on embeddings.
    vi.mocked(search.refresh).mockResolvedValueOnce({ processed: 2, removed: 0, caughtUp: true,
      embedding: { tokens: 500, costMicroUsd: 10, stopped: null } });
    expect(await steps.search_refresh!(context({ kind: "search_refresh" }))).toEqual({ caughtUp: true, stopCode: null,
      summary: { processed: 2, removed: 0, embeddingTokens: 500, embeddingCostMicroUsd: 10 } });
    // A refresh that made no count of progress but is not stuck (the graph sweep) keeps going; a stuck one stops.
    expect(await steps.graph_refresh!(context({ kind: "graph_refresh" }))).toMatchObject({ caughtUp: false, stopCode: null });
    vi.mocked(graph.refresh).mockResolvedValueOnce({ processed: 0, removed: 0, caughtUp: false, stopReason: "vector_cap" });
    expect(await steps.graph_refresh!(context({ kind: "graph_refresh" }))).toEqual({
      caughtUp: false, stopCode: "vector_cap", summary: { processed: 0, removed: 0, stopCode: "vector_cap" },
    });
    // A refresh that caught up anyway never stops on a stale reason.
    vi.mocked(graph.refresh).mockResolvedValueOnce({ processed: 1, removed: 0, caughtUp: true, stopReason: "vector_cap" });
    expect(await steps.graph_refresh!(context({ kind: "graph_refresh" }))).toMatchObject({ caughtUp: true, stopCode: null });
    expect(await steps.brief!(context({ kind: "brief", window: "week" }))).toEqual({
      caughtUp: true, stopCode: null, summary: { date: "2026-10-02", window: "week", stored: true, truncated: false },
    });
    expect(brief.generateBrief).toHaveBeenCalledWith("owner_s", "proj_s", { window: "week" });
    await steps.brief!(context({ kind: "sync" }));
    expect(brief.generateBrief).toHaveBeenLastCalledWith("owner_s", "proj_s", { window: "day" });
  });

  it("leaves out kinds whose service is off", async () => {
    const project = {} as BrainProjectService;
    const steps = createBrainJobSteps({ project, sources: null, search: null, graph: null, brief: null });
    expect(Object.keys(steps).sort()).toEqual(["extract", "sync"]);
    expect(await steps.sync!(context({ kind: "sync", sourceId: `src_${"e".repeat(32)}` })))
      .toEqual({ caughtUp: false, stopCode: "sources_unavailable", summary: {} });
    expect(Object.keys(createBrainJobSteps({ project })).sort()).toEqual(["extract", "sync"]);
  });
});
