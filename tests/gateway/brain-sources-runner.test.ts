import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_SOURCE_SYNC_LIMIT_CEILINGS, type BrainSourceAdapter, type BrainSourceReadContext, type BrainSourceReadResult,
} from "../../packages/gateway/src/brain/contracts.js";
import { runBrainSourceSync } from "../../packages/gateway/src/brain/sources/core/index.js";
import { BrainStoreError, type BrainSyncUpsertInput } from "../../packages/gateway/src/brain/types.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";
import { connectorHarness, connectorScope, recordingHooks, type ConnectorHarness } from "./helpers/brain-source-connectors-fakes.js";

let harness: ConnectorHarness | null = null;
afterEach(async () => {
  await harness?.destroy();
  harness = null;
});

const doc = (seed: string, overrides: Partial<BrainSyncUpsertInput> = {}): BrainSyncUpsertInput => ({
  documentId: brainDocumentId(seed), title: `Issue ${seed}`, body: `Body ${seed}`, permalink: "",
  sourceUpdatedAt: "2026-09-01T00:00:00.000Z", provenance: "linear_issue", refs: [{ kind: "label", value: "bug" }], ...overrides,
});

type Step = BrainSourceReadResult | Error | ((context: BrainSourceReadContext<unknown>) => Promise<BrainSourceReadResult>);

function scripted(steps: Step[], kind: BrainSourceAdapter<unknown>["kind"] = "linear") {
  const seen: BrainSourceReadContext<unknown>[] = [];
  const adapter: BrainSourceAdapter<unknown> = {
    kind,
    async readPage(context) {
      seen.push(context);
      const step = steps.shift();
      if (step === undefined) throw new Error("no more pages");
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step(context) : step;
    },
  };
  return { adapter, seen };
}

/** The repository with some methods replaced; the rest keep their prototype behaviour. */
function patched<T extends object>(repository: T, overrides: object): T {
  return Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, overrides);
}

function page(
  upserts: BrainSyncUpsertInput[], nextCursor: string, caughtUp: boolean, extra: Partial<{ deletions: string[]; skipped: number; notices: ("body_truncated" | "pages_capped")[] }> = {},
): BrainSourceReadResult {
  return { ok: true, page: { upserts, deletions: extra.deletions ?? [], nextCursor, caughtUp, skipped: extra.skipped ?? 0, notices: extra.notices ?? [] } };
}

describe("runBrainSourceSync", () => {
  it("applies pages in order, moves the cursor, emits hooks and closes a succeeded receipt", async () => {
    harness = await connectorHarness("linear");
    const hooks = recordingHooks();
    const { adapter, seen } = scripted([
      page([doc("a"), doc("b")], "c1", false, { notices: ["body_truncated"], skipped: 1 }),
      page([doc("c", { refs: undefined })], "c2", true, { deletions: [brainDocumentId("a")], notices: ["body_truncated", "pages_capped"] }),
    ]);
    const result = await harness.sync(adapter, { any: true }, { hooks });
    expect(result).toMatchObject({
      status: "succeeded", errorCode: null, nextAction: "", caughtUp: true, pages: 2, skipped: 1,
      counts: { read: 4, written: 3, unchanged: 0, deleted: 1, failed: 0 }, notices: ["body_truncated", "pages_capped"],
    });
    expect(result.receipt).toMatchObject({ status: "succeeded", cursorBefore: null, cursorAfter: "c2" });
    expect(seen.map((context) => context.cursor)).toEqual([null, "c1"]);
    expect(seen[0]).toMatchObject({ externalRef: "linear:test", limits: { maxUpserts: 100, maxDeletions: 200, maxRefs: 5_000 } });
    expect(seen[0]!.now().toISOString()).toBe(harness.iso());
    expect(hooks.events.map((event) => event.type === "documents_changed" ? event.documentIds?.length : -1)).toEqual([2, 2]);
    expect(await harness.liveIds()).toEqual([brainDocumentId("b"), brainDocumentId("c")].sort());
    const again = await harness.sync(scripted([page([doc("b")], "c2", true)]).adapter, {}, { hooks });
    expect(again.counts).toMatchObject({ read: 1, unchanged: 1, written: 0 });
    expect(hooks.events).toHaveLength(2);
  });

  it("stops at the page cap and the run budget with run_again", async () => {
    harness = await connectorHarness("linear");
    const capped = await harness.sync(scripted([page([doc("a")], "c1", false), page([doc("b")], "c2", false)]).adapter, {},
      { limits: { pagesPerRun: 1, upsertsPerPage: 999, refsPerPage: 99_999 } });
    expect(capped).toMatchObject({ status: "succeeded", nextAction: "run_again", caughtUp: false, pages: 1 });
    let clock = 0;
    const budget = await harness.sync(scripted([
      async () => { clock += 50; return page([doc("b")], "c2", false); },
      page([doc("c")], "c3", true),
    ]).adapter, {}, { now: () => clock, limits: { runBudgetMs: 10 } });
    expect(budget).toMatchObject({ pages: 1, caughtUp: false, nextAction: "run_again", notices: ["run_budget_exhausted"] });
  });

  it("lets a started page outlast the run budget and fails a page past the ceiling", async () => {
    harness = await connectorHarness("linear");
    const { adapter, seen } = scripted([async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      context.signal.throwIfAborted();
      return page([doc("a")], "c1", false);
    }, page([doc("b")], "c2", true)]);
    const slow = await harness.sync(adapter, {}, { now: Date.now, limits: { runBudgetMs: 5 } });
    expect(slow).toMatchObject({ status: "succeeded", pages: 1, counts: { written: 1 }, notices: ["run_budget_exhausted"] });
    expect(seen[0]!.signal.aborted).toBe(false);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === BRAIN_SOURCE_SYNC_LIMIT_CEILINGS.runBudgetMs ? AbortSignal.abort() : timeout(ms));
    const stuck = await harness.sync(scripted([async (context) => {
      context.signal.throwIfAborted();
      return page([], "c3", true);
    }]).adapter, {});
    spy.mockRestore();
    expect(stuck).toMatchObject({ status: "failed", errorCode: "provider_timeout", pages: 0 });
  });

  it("treats an adapter aborted by the run signal as an exhausted budget", async () => {
    harness = await connectorHarness("linear");
    const controller = new AbortController();
    const result = await harness.sync(scripted([async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }]).adapter, {}, { signal: controller.signal });
    expect(result).toMatchObject({ status: "succeeded", pages: 0, notices: ["run_budget_exhausted"], nextAction: "run_again" });
    const before = await harness.sync(scripted([page([doc("a")], "c1", false)]).adapter, {}, { signal: controller.signal });
    expect(before).toMatchObject({ pages: 0, notices: ["run_budget_exhausted"] });
  });

  it("records adapter failures with their next action and retry hint", async () => {
    harness = await connectorHarness("linear");
    const limited = await harness.sync(scripted([
      page([doc("a")], "c1", false), { ok: false, code: "rate_limited", retryAfterSeconds: 30 },
    ]).adapter, {});
    expect(limited).toMatchObject({
      status: "failed", errorCode: "rate_limited", nextAction: "retry_later", retryAfterSeconds: 30, caughtUp: false,
      counts: { written: 1 },
    });
    expect(limited.receipt).toMatchObject({ status: "failed", errorCode: "rate_limited", cursorAfter: "c1" });
    const bare = await harness.sync(scripted([{ ok: false, code: "rate_limited" }]).adapter, {});
    expect(bare.retryAfterSeconds).toBe(60);
    const auth = await harness.sync(scripted([{ ok: false, code: "auth_failed" }]).adapter, {});
    expect(auth).toMatchObject({ errorCode: "auth_failed", nextAction: "connect_account", retryAfterSeconds: null });
    const thrown = await harness.sync(scripted([new TypeError("boom")]).adapter, {});
    expect(thrown).toMatchObject({ status: "failed", errorCode: "internal_error", nextAction: "contact_support" });
  });

  it("refuses pages the source kind may not write", async () => {
    harness = await connectorHarness("linear");
    const wrong = await harness.sync(scripted([page([doc("a", { provenance: "google_doc" })], "c1", true)]).adapter, {});
    expect(wrong).toMatchObject({ status: "failed", errorCode: "document_invalid" });
    const tooMany = await harness.sync(scripted([page([doc("a"), doc("b")], "c1", true)]).adapter, {},
      { limits: { upsertsPerPage: 1 } });
    expect(tooMany.errorCode).toBe("document_invalid");
    const badSkip = await harness.sync(scripted([page([], "c1", true, { skipped: -1 })]).adapter, {});
    expect(badSkip.errorCode).toBe("document_invalid");
    const halfSkip = await harness.sync(scripted([page([], "c1", true, { skipped: 0.5 })]).adapter, {});
    expect(halfSkip.errorCode).toBe("document_invalid");
    const twoRefs = [{ kind: "label", value: "a" }, { kind: "label", value: "b" }];
    const single = await harness.sync(scripted([page([doc("r", { refs: twoRefs })], "c1", true)]).adapter, {},
      { limits: { refsPerPage: 1 } });
    expect(single.status).toBe("succeeded");
    const pair = await harness.sync(scripted([page([doc("s"), doc("t")], "c2", true)]).adapter, {}, { limits: { refsPerPage: 1 } });
    expect(pair.errorCode).toBe("document_invalid");
    const storeRefused = await harness.sync(scripted([page([doc("a", { title: " " })], "c1", true)]).adapter, {});
    expect(storeRefused.errorCode).toBe("document_invalid");
    expect(await harness.liveIds()).toEqual([brainDocumentId("r")]);
  });

  it("maps store failures, conflicts, capacity, foreign documents and a source paused or deleted mid-run", async () => {
    harness = await connectorHarness("linear", "linear:test", { maxDocumentsPerScope: 3 });
    const h = harness;
    const repo = h.repository;
    const run = (overrides: object) => runBrainSourceSync({
      repository: patched(repo, overrides), scope: connectorScope, sourceId: h.sourceId, config: {},
      adapter: scripted([page([doc("a")], "c1", true)]).adapter,
    });
    expect((await run({ applySyncBatch: async () => { throw new BrainStoreError("forbidden"); } })).errorCode).toBe("internal_error");
    let reads = 0;
    const conflicted = await run({
      applySyncBatch: async () => { throw new BrainStoreError("conflict"); },
      getSource: async (...args: Parameters<typeof repo.getSource>) => {
        reads += 1;
        if (reads > 1) throw new Error("db down");
        return repo.getSource(...args);
      },
    });
    expect(conflicted.errorCode).toBe("cursor_conflict");
    expect((await run({ openSyncReceipt: async () => { throw new BrainStoreError("conflict"); } })).errorCode).toBe("source_inactive");
    const cursorDown = await run({ getSyncCursor: async () => { throw new Error("db down"); } });
    expect(cursorDown).toMatchObject({ errorCode: "store_unavailable", receipt: { status: "failed" } });
    const raced = await h.sync(scripted([async () => {
      await h.repository.applySyncBatch(connectorScope, {
        sourceId: h.sourceId, expectedCursor: null, nextCursor: "other", upserts: [], deletions: [],
      });
      return page([doc("a")], "c1", true);
    }]).adapter, {});
    expect(raced).toMatchObject({ errorCode: "cursor_conflict", nextAction: "retry_later" });
    const { source: other } = await h.repository.createSource(connectorScope, { kind: "github", externalRef: "o/r", label: "gh" });
    await h.repository.applySyncBatch(connectorScope, {
      sourceId: other.sourceId, expectedCursor: null, nextCursor: "x", upserts: [doc("owned", { provenance: "github_pr" })], deletions: [],
    });
    const partial = await h.sync(scripted([page([doc("owned"), doc("mine")], "c2", true)]).adapter, {});
    expect(partial).toMatchObject({
      status: "partial", errorCode: "documents_rejected", rejectedDocumentIds: [brainDocumentId("owned")],
      counts: { read: 2, written: 1, failed: 1 },
    });
    const full = await h.sync(scripted([page([doc("p"), doc("q")], "c3", true)]).adapter, {});
    expect(full).toMatchObject({ errorCode: "brain_capacity", nextAction: "raise_capacity" });
    const paused = await h.sync(scripted([async () => {
      await repo.updateSource(connectorScope, { sourceId: h.sourceId, expectedRevision: 1, status: "paused" });
      return page([doc("x")], "c4", true);
    }]).adapter, {});
    expect(paused.errorCode).toBe("source_inactive");
    await repo.updateSource(connectorScope, { sourceId: h.sourceId, expectedRevision: 2, status: "active" });
    const gone = await h.sync(scripted([async () => {
      await repo.deleteSource(connectorScope, { sourceId: h.sourceId, expectedRevision: 3 });
      return page([doc("y")], "c4", true);
    }]).adapter, {});
    expect(gone.errorCode).toBe("source_unavailable");
  });

  it("returns pre-receipt codes without opening a receipt", async () => {
    harness = await connectorHarness("linear");
    const { adapter } = scripted([]);
    const base = { repository: harness.repository, scope: connectorScope, sourceId: harness.sourceId, adapter, config: {} };
    expect((await runBrainSourceSync({ ...base, sourceId: "src_bad" })).errorCode).toBe("invalid_options");
    expect((await runBrainSourceSync({ ...base, limits: { pagesPerRun: 0 } })).errorCode).toBe("invalid_options");
    expect((await runBrainSourceSync({ ...base, adapter: { kind: "git", readPage: adapter.readPage } as never })).errorCode)
      .toBe("invalid_options");
    expect((await runBrainSourceSync({ ...base, adapter: { kind: "linear" } as never })).errorCode).toBe("invalid_options");
    expect((await runBrainSourceSync({ ...base, now: 5 as never })).errorCode).toBe("invalid_options");
    expect((await runBrainSourceSync({ ...base, sourceId: `src_${"0".repeat(32)}` })).errorCode).toBe("source_unavailable");
    expect((await runBrainSourceSync({ ...base, adapter: scripted([], "google_drive").adapter })).errorCode)
      .toBe("source_kind_mismatch");
    await harness.repository.updateSource(connectorScope, { sourceId: harness.sourceId, expectedRevision: 1, status: "paused" });
    expect(await runBrainSourceSync(base)).toMatchObject({ errorCode: "source_inactive", nextAction: "fix_source", receipt: null });
    expect(await harness.repository.listSyncReceipts(connectorScope, harness.sourceId)).toEqual([]);
  });

  it("guards re-entry per source and survives store outages", async () => {
    harness = await connectorHarness("linear");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = harness.sync(scripted([async () => { await gate; return page([], "c1", true); }]).adapter, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await harness.sync(scripted([]).adapter, {})).errorCode).toBe("sync_in_progress");
    release();
    expect((await first).status).toBe("succeeded");
    const broken = patched(harness.repository, { getSource: async () => { throw new Error("db down"); } });
    const outage = await runBrainSourceSync({
      repository: broken, scope: connectorScope, sourceId: harness.sourceId, adapter: scripted([]).adapter, config: {},
    });
    expect(outage.errorCode).toBe("store_unavailable");
    const crash = await runBrainSourceSync({
      repository: harness.repository, scope: connectorScope, sourceId: harness.sourceId, config: {},
      adapter: scripted([]).adapter, limits: { get pagesPerRun(): number { throw new Error("getter"); } },
    });
    expect(crash.errorCode).toBe("internal_error");
  });

  it("skips the batch for an empty page that keeps the cursor and logs a failed receipt close", async () => {
    harness = await connectorHarness("linear");
    await harness.sync(scripted([page([], "c1", false), page([], "c1", true)]).adapter, {});
    expect((await harness.repository.getSyncCursor(connectorScope, harness.sourceId))?.cursor).toBe("c1");
    const closing = patched(harness.repository, { closeSyncReceipt: async () => { throw new Error("close failed"); } });
    const result = await runBrainSourceSync({
      repository: closing, scope: connectorScope, sourceId: harness.sourceId, adapter: scripted([page([], "c1", true)]).adapter,
      config: {},
    });
    expect(result).toMatchObject({ status: "succeeded", receipt: null });
  });
});
