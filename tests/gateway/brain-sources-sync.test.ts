import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrainProjectService } from "../../packages/gateway/src/brain/api/service.js";
import {
  BrainApiError, type BrainGitSync, type BrainProjectLookup, type BrainSyncView,
} from "../../packages/gateway/src/brain/api/types.js";
import {
  BrainFeatureError, type BrainAnySourceKindHandler, type BrainSourceSyncResult, type BrainSourceSyncRunner,
} from "../../packages/gateway/src/brain/contracts.js";
import {
  createBrainGitSourceSync, createBrainSourcesService, gitSyncToSourceView, runBrainSourceSync,
  type BrainSourcesCoreDeps,
} from "../../packages/gateway/src/brain/sources/core/index.js";
import { BrainStoreError } from "../../packages/gateway/src/brain/types.js";
import { zeroCounts } from "./helpers/brain-store-helpers.js";
import {
  fakeAdapter, fakeDocumentId, fakeHandler, OWNER, SCOPE_A, sourcesHarness, type SourcesHarness,
} from "./helpers/brain-sources-fixture.js";

let harness: SourcesHarness;
beforeEach(async () => {
  harness = await sourcesHarness();
});
afterEach(async () => {
  await harness.destroy();
  vi.restoreAllMocks();
});

function service(handlers: BrainAnySourceKindHandler[], extra: Partial<BrainSourcesCoreDeps> = {}) {
  return createBrainSourcesService({
    repository: harness.repository, resolver: harness.resolver, handlers, runner: runBrainSourceSync, hooks: harness.hooks,
    ...extra,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  if (error instanceof BrainFeatureError || error instanceof BrainApiError || error instanceof BrainStoreError) return error.code;
  throw new Error(`expected a coded error, got ${String(error)}`);
}

const early = (errorCode: BrainSourceSyncResult["errorCode"], status: BrainSourceSyncResult["status"] = "failed"): BrainSourceSyncResult => ({
  status, errorCode, nextAction: "retry_later", receipt: null, counts: zeroCounts, caughtUp: false, pages: 0, skipped: 0,
  retryAfterSeconds: null, rejectedDocumentIds: [], notices: [],
});

describe("sync", () => {
  it("runs one bounded run with the stored config, the hooks and the limits, and keeps its receipt", async () => {
    const runner = vi.fn<BrainSourceSyncRunner>(runBrainSourceSync);
    const sources = service([fakeHandler("linear")], { runner, limits: { pagesPerRun: 3 } });
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a", "b"] } });
    const view = await sources.sync(OWNER, "alpha", source.sourceId);
    expect(view).toMatchObject({
      sourceId: source.sourceId, status: "succeeded", errorCode: null, nextAction: "", caughtUp: true, pages: 1,
      counts: { read: 2, written: 2, unchanged: 0, deleted: 0, failed: 0 }, notices: [], retryAfterSeconds: null,
      receipt: { status: "succeeded", counts: { written: 2 } },
    });
    expect(Object.keys(view.receipt!).sort()).toEqual(["counts", "errorCode", "finishedAt", "nextAction", "receiptId", "startedAt", "status"]);
    expect(runner.mock.calls[0]![0]).toMatchObject({ scope: SCOPE_A, sourceId: source.sourceId, config: { items: ["a", "b"] },
      limits: { pagesPerRun: 3 }, hooks: harness.hooks });
    expect(harness.hooks.events).toEqual([expect.objectContaining({
      type: "documents_changed", sourceId: source.sourceId,
      documentIds: [fakeDocumentId("linear:a,b:", "a"), fakeDocumentId("linear:a,b:", "b")],
    })]);
    const receipts = await sources.receipts(OWNER, "proj_a", source.sourceId, 99);
    expect(receipts.receipts).toHaveLength(1);
    expect(receipts.source).toMatchObject({ sourceId: source.sourceId, lastSync: { status: "succeeded" } });
    expect((await sources.receipts(OWNER, "proj_a", source.sourceId, Number.NaN)).receipts).toHaveLength(1);
  });

  it("reports a paused source as a failed run without a receipt and refuses missing configs", async () => {
    let connected = true;
    const handler = fakeHandler("linear", {
      adapter: async () => (connected ? { ok: true, adapter: fakeAdapter("linear") } : { ok: false, code: "not_connected" }),
    });
    const sources = service([handler]);
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    await sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 1, status: "paused" });
    // A paused source answers before its config or account is read: a disconnected account or a lost config never
    // turns that answer into an error.
    const paused = { status: "failed", errorCode: "source_inactive", nextAction: "fix_source", receipt: null };
    connected = false;
    handler.calls.length = 0;
    expect(await sources.sync(OWNER, "proj_a", source.sourceId)).toMatchObject(paused);
    handler.configs.clear();
    expect(await sources.sync(OWNER, "proj_a", source.sourceId)).toMatchObject(paused);
    expect(handler.calls).toEqual([]);
    await sources.update(OWNER, "proj_a", source.sourceId, { expectedRevision: 2, status: "active" });
    expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe("source_config_invalid");
  });

  it("maps adapter refusals to feature codes and bounds adapter creation", async () => {
    for (const [code, expected] of [["not_connected", "source_not_connected"], ["auth_failed", "source_auth_failed"],
      ["config_invalid", "source_config_invalid"]] as const) {
      const handler = fakeHandler("google_drive", { adapter: async () => ({ ok: false, code }) });
      const sources = service([handler]);
      const { source } = await sources.connect(OWNER, "proj_a", { kind: "google_drive", config: { items: [code.replaceAll("_", "")] } });
      expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe(expected);
    }
    const hanging = service([fakeHandler("google_drive", { adapter: () => new Promise(() => undefined) })], { callTimeoutMs: 100 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { source } = await hanging.connect(OWNER, "proj_a", { kind: "google_drive", config: { items: ["slow"] } });
    expect(await codeOf(hanging.sync(OWNER, "proj_a", source.sourceId))).toBe("brain_unavailable");
    expect(error).toHaveBeenCalledWith("[brain-sources] google_drive adapter timed out");
  });

  it("maps runner results that ended before a receipt", async () => {
    const results: BrainSourceSyncResult[] = [
      early("sync_in_progress"), early("source_unavailable"), early("internal_error"), early("invalid_options"),
      early(null, "succeeded"),
    ];
    const runner = vi.fn<BrainSourceSyncRunner>(async () => results.shift()!);
    const sources = service([fakeHandler("linear")], { runner });
    const { source } = await sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["a"] } });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe("sync_in_progress");
    expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe("source_not_found");
    expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe("brain_unavailable");
    expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe("brain_unavailable");
    expect(error).toHaveBeenCalledWith("[brain-sources] sync could not record a receipt:", "invalid_options");
    // A run whose receipt could not be closed still answers what it did.
    expect(await sources.sync(OWNER, "proj_a", source.sourceId)).toMatchObject({ status: "succeeded", receipt: null });
  });

  it("delegates git sources to gitSync and refuses them without it", async () => {
    const { source } = await harness.repository.createSource(SCOPE_A, { kind: "git", externalRef: "project:proj_a", label: "A" });
    expect(await codeOf(service([]).sync(OWNER, "proj_a", source.sourceId))).toBe("source_kind_unsupported");
    const gitView: BrainSyncView = {
      status: "succeeded", errorCode: "history_rewritten", nextAction: "", caughtUp: true, commitsProcessed: 3,
      commitsRemaining: 0, counts: { ...zeroCounts, read: 3, written: 3 },
      notices: ["history_rewritten", "paths_truncated", "invalid_paths_dropped", "message_truncated"],
      receipt: { receiptId: `rcp_${"a".repeat(32)}`, status: "succeeded", counts: zeroCounts, nextAction: "", errorCode: "history_rewritten",
        startedAt: "2026-10-01T10:00:00.000Z", finishedAt: "2026-10-01T10:00:01.000Z" },
    };
    const project = { sync: vi.fn(async () => gitView) };
    const sources = service([], { gitSync: createBrainGitSourceSync(project) });
    const stop = new AbortController();
    expect(await sources.sync(OWNER, "alpha", source.sourceId, stop.signal)).toEqual({
      sourceId: source.sourceId, status: "succeeded", errorCode: null, nextAction: "", caughtUp: true, pages: 1,
      counts: gitView.counts, notices: ["items_truncated", "body_truncated"], retryAfterSeconds: null, receipt: gitView.receipt,
    });
    expect(project.sync).toHaveBeenCalledWith(OWNER, "alpha", { sourceId: source.sourceId, signal: stop.signal });
    project.sync.mockRejectedValueOnce(new BrainApiError("checkout_unavailable"));
    expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe("checkout_unavailable");
    // The project service found another git source as the run started.
    project.sync.mockRejectedValueOnce(new BrainApiError("git_source_conflict"));
    expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe("source_conflict");
  });

  it("answers a paused git source like any other kind, also when it is paused or removed as the run starts", async () => {
    const { source } = await harness.repository.createSource(SCOPE_A, { kind: "git", externalRef: "project:proj_a", label: "A" });
    const setStatus = (expectedRevision: number, status: "active" | "paused") =>
      harness.repository.updateSource(SCOPE_A, { sourceId: source.sourceId, expectedRevision, status });
    await setStatus(1, "paused");
    const project = { sync: vi.fn(async (): Promise<BrainSyncView> => { throw new BrainApiError("git_source_unavailable"); }) };
    const sources = service([], { gitSync: createBrainGitSourceSync(project) });
    const paused = {
      sourceId: source.sourceId, status: "failed", errorCode: "source_inactive", nextAction: "fix_source", caughtUp: false,
      pages: 0, counts: zeroCounts, notices: [], retryAfterSeconds: null, receipt: null,
    };
    expect(await sources.sync(OWNER, "proj_a", source.sourceId)).toEqual(paused);
    expect(project.sync).not.toHaveBeenCalled();
    await setStatus(2, "active");
    project.sync.mockImplementationOnce(async () => {
      await setStatus(3, "paused");
      throw new BrainApiError("git_source_unavailable");
    });
    expect(await sources.sync(OWNER, "proj_a", source.sourceId)).toEqual(paused);
    await setStatus(4, "active");
    // Still active: the project service's refusal stands.
    expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe("git_source_unavailable");
    project.sync.mockImplementationOnce(async () => {
      await harness.repository.deleteSource(SCOPE_A, { sourceId: source.sourceId, expectedRevision: 5 });
      throw new BrainApiError("git_source_missing");
    });
    expect(await codeOf(sources.sync(OWNER, "proj_a", source.sourceId))).toBe("source_not_found");
  });

  it("syncs only the project's git source, never another one a registration race left, under its id", async () => {
    const older = await harness.repository.createSource(SCOPE_A, { kind: "git", externalRef: "https://github.com/acme/app", label: "App" });
    harness.tick();
    const newer = await harness.repository.createSource(SCOPE_A, { kind: "git", externalRef: "project:proj_a", label: "A" });
    const gitView: BrainSyncView = {
      status: "succeeded", errorCode: null, nextAction: "", caughtUp: true, commitsProcessed: 0, commitsRemaining: 0,
      counts: zeroCounts, notices: [], receipt: null,
    };
    const project = { sync: vi.fn(async () => gitView) };
    const sources = service([], { gitSync: createBrainGitSourceSync(project) });
    expect(await codeOf(sources.sync(OWNER, "proj_a", newer.source.sourceId))).toBe("source_conflict");
    expect(project.sync).not.toHaveBeenCalled();
    expect(await sources.sync(OWNER, "proj_a", older.source.sourceId)).toMatchObject({ sourceId: older.source.sourceId, status: "succeeded" });
    expect(project.sync).toHaveBeenCalledOnce();
  });

  it("has the project service run only the git source the caller named, with the caller's signal", async () => {
    const older = await harness.repository.createSource(SCOPE_A, { kind: "git", externalRef: "https://github.com/acme/app", label: "App" });
    harness.tick();
    const newer = await harness.repository.createSource(SCOPE_A, { kind: "git", externalRef: "project:proj_a", label: "A" });
    const run = vi.fn<BrainGitSync>(async () => ({
      status: "succeeded", errorCode: null, nextAction: "", receipt: null, counts: zeroCounts, cursorBefore: null,
      cursorAfter: null, commitsProcessed: 0, commitsRemaining: 0, caughtUp: true, historyRewritten: false, batches: 0,
      rejectedDocumentIds: [], notices: [],
    }));
    const projects = {
      getProjectById: async () => ({ ok: true, project: { id: "proj_a", slug: "alpha", name: "Alpha" } }),
      resolveProjectWorkingDirectory: async () => "/home/projects/alpha",
    } as unknown as BrainProjectLookup;
    const project = createBrainProjectService({ repository: harness.repository, projects, homePath: "/home", sync: run });
    expect(await codeOf(project.sync(OWNER, "proj_a", { sourceId: newer.source.sourceId }))).toBe("git_source_conflict");
    expect(run).not.toHaveBeenCalled();
    const stop = new AbortController();
    await project.sync(OWNER, "proj_a", { sourceId: older.source.sourceId, signal: stop.signal });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sourceId: older.source.sourceId, signal: stop.signal }));
  });

  it("maps git codes onto the source vocabulary and keeps the git code on the receipt", () => {
    const base: BrainSyncView = {
      status: "failed", errorCode: "not_a_repository", nextAction: "fix_source", caughtUp: false, commitsProcessed: 0,
      commitsRemaining: 0, counts: zeroCounts, notices: ["spec_file_oversize", "spec_file_not_text", "run_budget_exhausted", "spec_files_capped"],
      receipt: null,
    };
    expect(gitSyncToSourceView("src", base)).toMatchObject({
      errorCode: "config_invalid", pages: 0, notices: ["too_large_skipped", "binary_skipped", "run_budget_exhausted", "items_truncated"],
    });
    const codes = {
      git_unavailable: "provider_unavailable", git_timeout: "provider_timeout", git_output_malformed: "provider_output_invalid",
      cursor_conflict: "cursor_conflict", documents_rejected: "documents_rejected", remote_mismatch: "config_invalid",
    } as const;
    for (const [git, source] of Object.entries(codes)) {
      expect(gitSyncToSourceView("src", { ...base, errorCode: git as BrainSyncView["errorCode"] }).errorCode).toBe(source);
    }
    expect(gitSyncToSourceView("src", { ...base, errorCode: null }).errorCode).toBeNull();
  });
});

describe("options", () => {
  it("answers an empty list for kinds without lookups and bounds what a handler returns", async () => {
    const items = [
      ...Array.from({ length: 98 }, (_, index) => ({ id: `id${index}`, label: "x".repeat(500), detail: null })),
      { id: "", label: "empty", detail: null }, { id: "y".repeat(300), label: "long", detail: "d".repeat(300) },
      { id: "past", label: "past the cap", detail: null },
    ];
    const lister = fakeHandler("google_drive", { listOptions: async () => ({ kind: "google_drive", items, nextCursor: "c".repeat(600) }) });
    const sources = service([fakeHandler("linear"), lister]);
    expect(await sources.options(OWNER, "proj_a", "linear", {})).toEqual({ kind: "linear", items: [], nextCursor: null });
    const page = await sources.options(OWNER, "proj_a", "google_drive", { q: "a" });
    expect(page.items).toHaveLength(98);
    expect(page.items[0]).toEqual({ id: "id0", label: "x".repeat(200), detail: null });
    expect(page.nextCursor).toBeNull();
    const short = fakeHandler("google_drive", {
      listOptions: async () => ({ kind: "google_drive", items: [{ id: "f", label: "F", detail: "d".repeat(250) }], nextCursor: "next" }),
    });
    expect(await service([short]).options(OWNER, "proj_a", "google_drive", {}))
      .toEqual({ kind: "google_drive", items: [{ id: "f", label: "F", detail: "d".repeat(200) }], nextCursor: "next" });
  });

  it("refuses kinds without a handler and missing projects, and bounds a slow lookup", async () => {
    const sources = service([fakeHandler("linear")]);
    expect(await codeOf(sources.options(OWNER, "proj_a", "slack_bridge", {}))).toBe("source_kind_unsupported");
    expect(await codeOf(sources.options("owner_b", "proj_a", "linear", {}))).toBe("project_not_found");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const slow = fakeHandler("google_drive", { listOptions: () => new Promise(() => undefined) });
    expect(await codeOf(service([slow], { callTimeoutMs: 100 }).options(OWNER, "proj_a", "google_drive", {}))).toBe("brain_unavailable");
    const failing = fakeHandler("google_drive", { listOptions: async () => { throw new BrainFeatureError("source_config_invalid"); } });
    expect(await codeOf(service([failing]).options(OWNER, "proj_a", "google_drive", {}))).toBe("source_config_invalid");
  });

  it("answers options of a kind that cannot be connected as connect does, never with an empty list", async () => {
    const listOptions = vi.fn(async () => ({ kind: "google_drive" as const, items: [], nextCursor: null }));
    for (const [reason, code] of [["not_connected", "source_not_connected"], ["not_configured", "source_kind_unsupported"]] as const) {
      const handler = fakeHandler("google_drive", { listOptions, availability: async () => ({ available: false, reason }) });
      expect(await codeOf(service([handler]).options(OWNER, "proj_a", "google_drive", {}))).toBe(code);
    }
    expect(listOptions).not.toHaveBeenCalled();
  });
});
