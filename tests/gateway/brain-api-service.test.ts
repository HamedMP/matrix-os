/**
 * createBrainProjectService over a real PGlite BrainRepository and a real
 * fixture repository, with a stub project lookup that only owner_a can see.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createBrainAgentTools } from "../../packages/gateway/src/brain/api/agent-tools.js";
import { createBrainProjectService, startBrainProjectService } from "../../packages/gateway/src/brain/api/service.js";
import {
  BRAIN_STORE_ERROR_API_CODES, BrainApiError, brainProjectScope,
  type BrainApiErrorCode, type BrainGitSync, type BrainProjectLookup, type BrainProjectServiceDeps,
} from "../../packages/gateway/src/brain/api/types.js";
import { syncGitSource, type GitSyncErrorCode, type GitSyncResult } from "../../packages/gateway/src/brain/git/index.js";
import { BrainRepository, BrainStoreError, type BrainSyncReceipt } from "../../packages/gateway/src/brain/index.js";
import type { ProjectConfig } from "../../packages/gateway/src/project-manager.js";
import { createBrainWhyToolHandler } from "../../packages/kernel/src/tools/brain-why.js";
import type { OwnerScope } from "../../packages/gateway/src/state-ops.js";
import { FIXTURE_WEB_BASE, buildBaseHistory } from "./helpers/brain-git-fixture.js";
import { useGitSyncHarness } from "./helpers/brain-git-harness.js";
import { zeroCounts } from "./helpers/brain-store-helpers.js";

const OWNER = "owner_a";
const PROJECT_ID = "proj_widgets";
const SCOPE = brainProjectScope(OWNER, PROJECT_ID);
const AT = "2026-10-01T10:00:00.000Z";

type LookupResult = Awaited<ReturnType<BrainProjectLookup["getProjectById"]>>;
type LookupOptions = { readonly failStatus?: number; readonly checkout?: string | null };

/** A BrainApiError's code; a BrainStoreError as `store:<the API code routes map it to>`. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  if (error instanceof BrainApiError) return error.code;
  if (error instanceof BrainStoreError) return `store:${BRAIN_STORE_ERROR_API_CODES[error.code]}`;
  return error === null ? "resolved" : "other";
}

function runResult(overrides: Partial<GitSyncResult>): GitSyncResult {
  return {
    status: "failed", errorCode: "store_unavailable", nextAction: "retry_later", receipt: null, counts: zeroCounts,
    cursorBefore: null, cursorAfter: null, commitsProcessed: 0, commitsRemaining: 0, caughtUp: false,
    historyRewritten: false, batches: 0, rejectedDocumentIds: [], notices: [], ...overrides,
  };
}

describe("brain project service", { timeout: 60_000 }, () => {
  const t = useGitSyncHarness({ muteWarnings: true });
  let errorLog: MockInstance<typeof console.error>;
  beforeEach(() => { errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => { errorLog.mockRestore(); });
  const logged = () => JSON.stringify([...t.warn.mock.calls, ...errorLog.mock.calls]);

  function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
    return {
      id: PROJECT_ID, name: "Widgets", slug: "widgets", kind: "folder", localPath: t.f.repoPath, addedAt: AT,
      updatedAt: AT, ownerScope: { type: "user", id: OWNER }, ...overrides,
    };
  }

  function lookup(projects: readonly ProjectConfig[] = [project()], options: LookupOptions = {}) {
    const answer = (scope: OwnerScope | undefined, match: (p: ProjectConfig) => boolean): LookupResult => {
      const found = projects.find((p) => match(p) && scope?.type === "user" && scope.id === p.ownerScope.id);
      const status = options.failStatus ?? (found ? 200 : 404);
      if (found && status === 200) return { ok: true, project: found };
      return { ok: false, status, error: { code: "not_found", message: "Project was not found" } };
    };
    return {
      getProjectById: vi.fn<BrainProjectLookup["getProjectById"]>(async (scope, id) => answer(scope, (p) => p.id === id)),
      getProject: vi.fn<BrainProjectLookup["getProject"]>(async (slug, scope) => answer(scope, (p) => p.slug === slug)),
      resolveProjectWorkingDirectory: vi.fn<BrainProjectLookup["resolveProjectWorkingDirectory"]>(
        async () => (options.checkout === undefined ? t.f.repoPath : options.checkout)),
    };
  }

  function service(projects: BrainProjectLookup = lookup(), extra: Partial<BrainProjectServiceDeps> = {}) {
    return createBrainProjectService({ repository: t.harness.repository, projects, homePath: t.f.homePath, ...extra });
  }

  it("registers one git source per project scope, keyed by the project id when no web base is known", async () => {
    const projects = lookup();
    const svc = service(projects);
    const first = await svc.registerGitSource(OWNER, PROJECT_ID, {});
    const [stored] = (await t.harness.repository.listSources(SCOPE)).items;
    expect([SCOPE.scopeId, stored?.kind]).toEqual(["personal:project:proj_widgets", "git"]);
    expect(first).toEqual({ created: true, source: {
      sourceId: stored!.sourceId, label: "Widgets", externalRef: "project:proj_widgets", webBase: null,
      status: "active", createdAt: stored!.createdAt, updatedAt: stored!.updatedAt,
    } });
    expect(projects.getProjectById).toHaveBeenCalledWith({ type: "user", id: OWNER }, PROJECT_ID);
    expect(await svc.registerGitSource(OWNER, PROJECT_ID, {})).toEqual({ ...first, created: false });
    expect(await svc.registerGitSource(OWNER, "widgets", {})).toEqual({ ...first, created: false });
    expect(projects.getProject).toHaveBeenCalledWith("widgets", { type: "user", id: OWNER });
    expect((await t.harness.repository.listSources(SCOPE)).items).toHaveLength(1);
    expect(projects.resolveProjectWorkingDirectory).not.toHaveBeenCalled();
  });

  it("prefers an explicit web base, then the GitHub page; labels from the name; refuses a different base", async () => {
    const github = { owner: "acme", repo: "widgets", htmlUrl: FIXTURE_WEB_BASE, authState: "ok" as const };
    const svc = service(lookup([
      project(), project({ id: "proj_gh", kind: "github", github, name: " Wid\u0000gets " }),
      project({ id: "proj_odd", slug: "odd", name: " \u0000 ", github: { ...github, htmlUrl: `${FIXTURE_WEB_BASE}/` } }),
    ]));
    expect((await svc.registerGitSource(OWNER, "proj_gh", {})).source)
      .toMatchObject({ externalRef: FIXTURE_WEB_BASE, webBase: FIXTURE_WEB_BASE, label: "Widgets" });
    expect((await svc.registerGitSource(OWNER, "proj_odd", {})).source)
      .toMatchObject({ externalRef: "project:proj_odd", webBase: null, label: "odd" });
    const webBase = "https://gitlab.com/acme/widgets";
    const created = await svc.registerGitSource(OWNER, PROJECT_ID, { webBase });
    expect(created).toMatchObject({ created: true, source: { externalRef: webBase, webBase } });
    expect(await svc.registerGitSource(OWNER, PROJECT_ID, { webBase })).toEqual({ ...created, created: false });
    expect(await svc.registerGitSource(OWNER, PROJECT_ID, {})).toEqual({ ...created, created: false });
    expect(await rejection(svc.registerGitSource(OWNER, PROJECT_ID, { webBase: FIXTURE_WEB_BASE })))
      .toBe("git_source_conflict");
  });

  it("keeps the oldest git source after a registration race and cuts labels before a split emoji", async () => {
    const create = async (kind: string, externalRef: string) =>
      (await t.harness.repository.createSource(SCOPE, { kind, externalRef, label: "Raced" })).source.sourceId;
    await create("slack", "T/C");
    const tied = [await create("git", "https://github.com/acme/a"), await create("git", "https://github.com/acme/b")];
    const oldest = tied.sort()[0];
    t.harness.tick(1_000);
    await create("git", "https://github.com/acme/c");
    const long = project({ id: "proj_long", slug: "long", name: `${"a".repeat(299)}\u{1F600}` });
    const svc = service(lookup([project(), long]));
    expect((await svc.registerGitSource(OWNER, PROJECT_ID, {})).source.sourceId).toBe(oldest);
    expect((await svc.listReceipts(OWNER, PROJECT_ID, 1)).source?.sourceId).toBe(oldest);
    expect((await svc.registerGitSource(OWNER, "proj_long", {})).source.label).toBe("a".repeat(299));
  });

  it("rejects web bases parseWebBase does not accept", async () => {
    for (const webBase of ["http://github.com/acme/widgets", `${FIXTURE_WEB_BASE}/`, "https://u@github.com/acme/widgets",
      `${FIXTURE_WEB_BASE}?x=1`, "project:proj_widgets", "not a url"]) {
      expect(await rejection(service().registerGitSource(OWNER, PROJECT_ID, { webBase })), webBase).toBe("invalid_request");
    }
    expect((await t.harness.repository.listSources(SCOPE)).items).toEqual([]);
  });

  it("answers project_not_found alike for foreign, missing, malformed and rejected projects", async () => {
    await service().registerGitSource(OWNER, PROJECT_ID, {});
    const calls = (svc: ReturnType<typeof service>, owner: string, ref: string) => [
      () => svc.registerGitSource(owner, ref, {}), () => svc.sync(owner, ref), () => svc.listReceipts(owner, ref, 10),
      () => svc.why(owner, ref, { path: "src/alpha.ts" }),
    ];
    const projects = lookup();
    for (const [owner, ref] of [["owner_b", PROJECT_ID], ["owner_b", "widgets"], [OWNER, "proj_missing"],
      [OWNER, "Not A Ref!"], [OWNER, "proj_a/../b"], [OWNER, ""]] as const) {
      for (const run of calls(service(projects), owner, ref)) {
        expect(await rejection(run()), `${owner} ${ref}`).toBe("project_not_found");
      }
    }
    expect(projects.resolveProjectWorkingDirectory).not.toHaveBeenCalled();
    for (const failStatus of [400, 404, 409, 503]) {
      const expected = failStatus < 405 ? "project_not_found" : "brain_unavailable";
      for (const run of calls(service(lookup(undefined, { failStatus })), OWNER, PROJECT_ID)) {
        expect(await rejection(run()), String(failStatus)).toBe(expected);
      }
    }
    expect(logged()).toMatch(/\[brain-api\] project lookup unavailable[\s\S]*409[\s\S]*503/);
    expect(logged()).not.toContain(t.f.homePath);
  });

  it("needs a registered, active source and a checkout before it runs a sync", async () => {
    const sync = vi.fn<BrainGitSync>(syncGitSource);
    expect(await rejection(service(lookup(), { sync }).sync(OWNER, PROJECT_ID))).toBe("git_source_missing");
    const { source } = await service().registerGitSource(OWNER, PROJECT_ID, {});
    expect(await rejection(service(lookup(undefined, { checkout: null }), { sync }).sync(OWNER, PROJECT_ID)))
      .toBe("checkout_unavailable");
    expect(sync).not.toHaveBeenCalled();

    const [stored] = (await t.harness.repository.listSources(SCOPE)).items;
    await t.harness.repository.updateSource(SCOPE, { sourceId: source.sourceId, expectedRevision: stored!.revision,
      status: "paused" });
    expect(await rejection(service(lookup(), { sync }).sync(OWNER, PROJECT_ID))).toBe("git_source_unavailable");
    expect(sync).toHaveBeenCalledTimes(1);
    expect((await service().registerGitSource(OWNER, PROJECT_ID, {})).source.status).toBe("paused");
  });

  it("maps receipt-less failures and returns failed runs that have a receipt", async () => {
    const { source } = await service().registerGitSource(OWNER, PROJECT_ID, {});
    const cases: ReadonlyArray<[GitSyncErrorCode, BrainApiErrorCode]> = [
      ["sync_in_progress", "sync_in_progress"], ["source_inactive", "git_source_unavailable"],
      ["source_unavailable", "git_source_unavailable"], ["source_kind_mismatch", "git_source_unavailable"],
      ["store_unavailable", "brain_unavailable"], ["invalid_options", "brain_unavailable"],
    ];
    for (const [errorCode, expected] of cases) {
      const sync = vi.fn<BrainGitSync>(async () => runResult({ errorCode }));
      expect(await rejection(service(lookup(), { sync }).sync(OWNER, PROJECT_ID)), errorCode).toBe(expected);
      expect(sync).toHaveBeenCalledTimes(1);
    }
    expect(logged()).toContain("[brain-api] sync could not record a receipt");
    expect(logged()).toContain("store_unavailable");
    const unclosed = runResult({ status: "succeeded", errorCode: null, nextAction: "", caughtUp: true });
    expect(await service(lookup(), { sync: async () => unclosed }).sync(OWNER, PROJECT_ID))
      .toMatchObject({ status: "succeeded", caughtUp: true, receipt: null });

    const receipt: BrainSyncReceipt = {
      scopeId: SCOPE.scopeId, sourceId: source.sourceId, receiptId: "e".repeat(64), status: "failed",
      counts: zeroCounts, nextAction: "fix_source", errorCode: "shallow_repository", cursorBefore: "a".repeat(40),
      cursorAfter: null, startedAt: AT, finishedAt: AT,
    };
    const failed = runResult({ errorCode: "shallow_repository", nextAction: "fix_source", receipt });
    const { scopeId: _scope, sourceId: _source, cursorBefore: _before, cursorAfter: _after, ...view } = receipt;
    expect(await service(lookup(), { sync: async () => failed }).sync(OWNER, PROJECT_ID)).toEqual({
      status: "failed", errorCode: "shallow_repository", nextAction: "fix_source", caughtUp: false,
      commitsProcessed: 0, commitsRemaining: 0, counts: zeroCounts, notices: [], receipt: view,
    });
  });

  it("answers why before any sync without syncing, and rejects bad paths and cursors", async () => {
    const sync = vi.fn<BrainGitSync>(syncGitSource);
    const svc = service(lookup(), { sync });
    expect(await svc.why(OWNER, PROJECT_ID, { path: "src/" })).toEqual({ path: "src", match: "folder", detail: "brief",
      total: 0, totalCapped: false, items: [], nextCursor: null, source: null });
    expect((await svc.why(OWNER, PROJECT_ID, { path: "src/a.ts", detail: "full" })).detail).toBe("full");
    for (const path of ["/abs", "a//", ""]) expect(await rejection(svc.why(OWNER, PROJECT_ID, { path })), path).toBe("invalid_request");

    const { source } = await svc.registerGitSource(OWNER, PROJECT_ID, {});
    expect(await svc.why(OWNER, PROJECT_ID, { path: "src/alpha.ts" })).toMatchObject({
      path: "src/alpha.ts", match: "file_or_folder", total: 0, items: [],
      source: { sourceId: source.sourceId, webBase: null, lastSync: null },
    });
    for (const query of [{ path: "a/../b" }, { path: "src", cursor: "garbage" }]) {
      expect(["invalid_request", "store:invalid_request"]).toContain(await rejection(svc.why(OWNER, PROJECT_ID, query)));
    }
    expect(sync).not.toHaveBeenCalled();
  });

  it("runs one bounded sync per request, lists receipts newest first and answers why from them", async () => {
    const h = await buildBaseHistory(t.f);
    const sync = vi.fn<BrainGitSync>(syncGitSource);
    const svc = service(lookup(), { sync, syncLimits: { commitsPerRun: 5 } });
    const { source } = await svc.registerGitSource(OWNER, PROJECT_ID, {});
    const first = await svc.sync(OWNER, PROJECT_ID);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]![0]).toMatchObject({
      repository: t.harness.repository, scope: SCOPE, sourceId: source.sourceId, repoPath: t.f.repoPath,
      homePath: t.f.homePath, config: {}, limits: { commitsPerRun: 5 },
    });
    const hidden = ["cursorBefore", "cursorAfter", "rejectedDocumentIds", "batches", "scopeId", "sourceId"];
    expect(hidden.filter((key) => key in first || key in first.receipt!)).toEqual([]);
    expect(first).toMatchObject({
      status: "succeeded", errorCode: null, nextAction: "run_again", caughtUp: false, commitsProcessed: 5,
      commitsRemaining: 4, receipt: { status: "succeeded", nextAction: "run_again" },
    });
    t.harness.tick(60_000);
    const second = await svc.sync(OWNER, PROJECT_ID);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ status: "succeeded", nextAction: "", caughtUp: true, commitsProcessed: 4 });
    expect(await svc.listReceipts(OWNER, PROJECT_ID, 10)).toEqual({ source, receipts: [second.receipt, first.receipt] });
    expect((await svc.listReceipts(OWNER, PROJECT_ID, 1)).receipts).toEqual([second.receipt]);
    expect(await service(lookup([project({ id: "proj_other" })])).listReceipts(OWNER, "proj_other", 10))
      .toEqual({ source: null, receipts: [] });

    const file = await svc.why(OWNER, PROJECT_ID, { path: "src/alpha.ts" });
    const { receiptId: _receiptId, counts: _counts, ...lastSync } = second.receipt!;
    expect(file).toMatchObject({ path: "src/alpha.ts", match: "file_or_folder", detail: "brief", total: 2,
      totalCapped: false, nextCursor: null });
    expect(file.source).toEqual({ sourceId: source.sourceId, webBase: null, lastSync });
    expect(file.items.map((item) => [item.kind, item.label, item.link, item.sha]))
      .toEqual([["commit", h.revert1.slice(0, 12), "none", h.revert1], ["pr", "#1", "inferred", h.squash1]]);
    // brain-why.test.ts covers item fields and paging; here the cursor passes through the service.
    const page = await svc.why(OWNER, PROJECT_ID, { path: "src/", limit: 3 });
    const rest = await svc.why(OWNER, PROJECT_ID, { path: "src/", limit: 3, cursor: page.nextCursor });
    expect([...page.items, ...rest.items].map((item) => item.label)).toEqual([h.revert1.slice(0, 12), "#3", "#2", "#1"]);
    expect([page.total, rest.nextCursor]).toEqual([4, null]);
    expect(await rejection(svc.why("owner_b", PROJECT_ID, { path: "src/" }))).toBe("project_not_found");
    // The agent's path: owner-bound adapter, then the kernel tool's answer text.
    const tool = createBrainWhyToolHandler(createBrainAgentTools(svc, OWNER)!);
    expect((await tool({ project: "widgets", path: "src/alpha.ts" })).content[0]?.text).toContain(
      `2. PR #1 \u00b7 ${file.items[1]!.date.slice(0, 10)} \u00b7 feat(brain): alpha [inferred link]\n   ${FIXTURE_WEB_BASE}/pull/1\n   Summary: - Adds alpha.`,
    );
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("defers the brain on a bootstrap deadline and fails closed on any other bootstrap error", async () => {
    const deps = { projects: lookup(), homePath: t.f.homePath };
    expect(await (await startBrainProjectService(t.harness.db, deps))?.listReceipts(OWNER, PROJECT_ID, 1))
      .toEqual({ source: null, receipts: [] });
    const bootstrap = vi.spyOn(BrainRepository.prototype, "bootstrap");
    for (const code of ["55P03", "57014"]) {
      bootstrap.mockRejectedValueOnce(Object.assign(new Error("deadline"), { code }));
      expect(await startBrainProjectService(t.harness.db, deps)).toBeNull();
      expect(t.warn).toHaveBeenLastCalledWith("[brain] bootstrap deferred after a database deadline:", code);
    }
    bootstrap.mockRejectedValueOnce(Object.assign(new Error("relation"), { code: "42P01" }));
    await expect(startBrainProjectService(t.harness.db, deps)).rejects.toMatchObject({ code: "42P01" });
    bootstrap.mockRejectedValueOnce(new TypeError("boom"));
    await expect(startBrainProjectService(t.harness.db, deps)).rejects.toBeInstanceOf(TypeError);
    bootstrap.mockRestore();
  });
});
