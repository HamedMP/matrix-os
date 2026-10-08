/**
 * What the brain repairs or refuses on its own: kinds with no integration transport read not_configured (never
 * "connect it in Settings"), a project erase clears the rows of features that did not start (and runs with the brain
 * off), a removed source's people and text are gone before the answer, and change events lost at shutdown are
 * indexed by the next start's catch-up.
 */
import type { Hono } from "hono";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createBrainApiRoutes, createBrainIndexCatchUp, createBrainProjectCleanup, eraseBrainProject, listBrainSourceScopes,
  purgeBrainRemovedSource, runBrainIndexCatchUp, startBrainServices, stopBrainServices,
  type BrainServicesHandle, type BrainServicesStartDeps,
} from "../../packages/gateway/src/brain/api/index.js";
import { brainProjectScope, type BrainProjectLookup } from "../../packages/gateway/src/brain/api/types.js";
import type { BrainDerivedIndex } from "../../packages/gateway/src/brain/contracts.js";
import type { BrainDatabase } from "../../packages/gateway/src/brain/index.js";
import {
  createBrainIntegrationAccounts, createBrainLateBoundIntegrations,
} from "../../packages/gateway/src/brain/sources/integration/index.js";
import { BrainJobStore, bootstrapBrainJobsDatabase } from "../../packages/gateway/src/brain/jobs/index.js";
import type { ProjectConfig } from "../../packages/gateway/src/project-manager.js";
import { createBrainHarness, brainDocumentId, type BrainHarness } from "./helpers/brain-store-helpers.js";

/** A graph or brief bootstrap that throws (the feature is off) while true. */
const off = vi.hoisted(() => ({ graph: false, brief: false }));
vi.mock("../../packages/gateway/src/brain/graph/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/brain/graph/index.js")>();
  return { ...actual, bootstrapBrainGraphDatabase: async (...args: Parameters<typeof actual.bootstrapBrainGraphDatabase>) => {
    if (off.graph) throw new Error("graph down");
    return actual.bootstrapBrainGraphDatabase(...args);
  } };
});
vi.mock("../../packages/gateway/src/brain/brief/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/brain/brief/index.js")>();
  return { ...actual, bootstrapBrainBriefDatabase: async (...args: Parameters<typeof actual.bootstrapBrainBriefDatabase>) => {
    if (off.brief) throw new Error("brief down");
    return actual.bootstrapBrainBriefDatabase(...args);
  } };
});

const OWNER = "owner_a";
const AT = "2026-10-01T10:00:00.000Z";
const PROJECT: ProjectConfig = {
  id: "proj_widgets", name: "Widgets", slug: "widgets", kind: "folder", localPath: "/home/widgets", addedAt: AT,
  updatedAt: AT, ownerScope: { type: "user", id: OWNER },
};
const SCOPE = brainProjectScope(OWNER, PROJECT.id);
const INTEGRATION_KINDS = ["github", "linear", "google_drive", "google_calendar"] as const;

const projects: BrainProjectLookup = {
  getProjectById: async (scope, id) => scope?.type === "user" && scope.id === OWNER && id === PROJECT.id
    ? { ok: true, project: PROJECT } : { ok: false, status: 404, error: { code: "not_found", message: "Not found" } },
  getProject: async (slug, scope) => scope?.type === "user" && scope.id === OWNER && slug === PROJECT.slug
    ? { ok: true, project: PROJECT } : { ok: false, status: 404, error: { code: "not_found", message: "Not found" } },
  resolveProjectWorkingDirectory: async () => "/home/widgets",
};

/** Rows of the scope across every brain_* table that has a scope_id column. */
async function scopeRows(harness: BrainHarness): Promise<number> {
  const { rows } = await sql<{ table_name: string }>`SELECT DISTINCT table_name FROM information_schema.columns
    WHERE table_name LIKE 'brain_%' AND column_name = 'scope_id'`.execute(harness.db);
  let total = 0;
  for (const { table_name: table } of rows) {
    const counted = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}
      WHERE owner_id = ${SCOPE.ownerId} AND scope_id = ${SCOPE.scopeId}`.execute(harness.db);
    total += counted.rows[0]!.n;
  }
  return total;
}

/** A Linear source with one issue assigned to a person, synced straight into the store (no change event). */
async function seedLinear(harness: BrainHarness, body = "The secret roadmap for the ledger.") {
  const { source } = await harness.repository.createSource(SCOPE, { kind: "linear", externalRef: "linear:eng", label: "L" });
  await harness.repository.applySyncBatch(SCOPE, {
    sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [],
    upserts: [{
      documentId: brainDocumentId("issue"), title: "Ship the ledger", body, permalink: "", sourceUpdatedAt: AT,
      provenance: "linear_issue", refs: [{ kind: "handle", value: "ENG-42" }, { kind: "assignee", value: "email:alice@acme.dev" }],
    }],
  });
  return source;
}

const people = async (services: BrainServicesHandle) =>
  (await services.graph!.listEntities(OWNER, "widgets", { kind: "person" })).items.map((item) => item.key);
const hits = async (services: BrainServicesHandle, q: string) =>
  (await services.search!.search(OWNER, "widgets", { q })).items.length;

describe("brain start repairs", { timeout: 60_000 }, () => {
  let harness: BrainHarness;
  let warn: MockInstance<typeof console.warn>;
  const started: BrainServicesHandle[] = [];
  const start = async (extra: Partial<BrainServicesStartDeps> = {}) => {
    const services = await startBrainServices(harness.db, {
      projects, homePath: "/home", claimModels: async () => null, scheduleOwnerId: null, ...extra,
    });
    started.push(services!);
    return services!;
  };
  beforeEach(async () => {
    harness = await createBrainHarness();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    for (const services of started.splice(0)) await stopBrainServices(services, 1_000);
    [off.graph, off.brief] = [false, false];
    vi.restoreAllMocks();
    await harness.destroy();
  });

  it("reads every integration kind as not_configured without a transport, before and after the bind", async () => {
    const late = createBrainLateBoundIntegrations();
    const services = await start({ sources: {
      integrations: late.caller, isConfigured: () => late.configured(), isConnected: late.isConnected,
      accounts: late.accounts,
    } });
    const routes: Hono = createBrainApiRoutes(services, (() => ({ userId: OWNER, source: "dev-default" })) as never);
    for (const bound of [false, true]) {
      if (bound) late.bind({ internalBaseUrl: null, db: null, pipedream: null });
      const kinds = new Map((await services.sources!.list(OWNER, "widgets")).kinds.map((view) => [view.kind, view]));
      for (const kind of INTEGRATION_KINDS) {
        expect(kinds.get(kind), `${kind} bound=${bound}`).toEqual({ kind, available: false, reason: "not_configured" });
      }
      const response = await routes.request("/projects/widgets/sources", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "linear", config: { teamKeys: ["ENG"] } }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "source_kind_unsupported" } });
    }
    expect(createBrainIntegrationAccounts({}).configured()).toBe(false);
    expect(createBrainIntegrationAccounts({ internalBaseUrl: "https://platform.invalid/i", machineToken: "t" })
      .configured()).toBe(true);
  });

  it("erases the rows of features that did not start on this boot, and with the brain off", async () => {
    const first = await start();
    await seedLinear(harness);
    for (const index of first.indexes) await index.refresh(SCOPE, {}, AbortSignal.timeout(10_000));
    expect((await first.brief!.getBrief(OWNER, "widgets", {})).stored).toBe(true);
    expect(await people(first)).toEqual(["email:alice@acme.dev"]);
    [off.graph, off.brief] = [true, true];
    const second = await start();
    expect([second.graph, second.brief]).toEqual([null, null]);
    await second.eraseProject(OWNER, PROJECT.id);
    expect(await scopeRows(harness)).toBe(0);

    // The brain off (deferred or failed) but the owner database up: the same erase runs straight on it, background
    // runs of the project included.
    await seedLinear(harness);
    for (const index of first.indexes) await index.refresh(SCOPE, {}, AbortSignal.timeout(10_000));
    await bootstrapBrainJobsDatabase(harness.db);
    await new BrainJobStore(harness.db).enqueue({ ownerId: OWNER, scopeId: SCOPE.scopeId }, PROJECT.id,
      { kind: "search_refresh" });
    expect(await scopeRows(harness)).toBeGreaterThan(3);
    await createBrainProjectCleanup({ databaseConfigured: true, db: harness.db, services: null })(OWNER, PROJECT.id);
    expect(await scopeRows(harness)).toBe(0);
    const eraseProject = vi.fn(async () => undefined);
    await createBrainProjectCleanup({ databaseConfigured: true, db: harness.db, services: { eraseProject } })(OWNER, "proj_x");
    expect(eraseProject).toHaveBeenCalledWith(OWNER, "proj_x");
    // An owner database that is configured but down fails the deletion; none configured has nothing to erase.
    await expect(createBrainProjectCleanup({ databaseConfigured: true, db: null, services: null })(OWNER, PROJECT.id))
      .rejects.toThrow("Project brain cleanup unavailable");
    await expect(createBrainProjectCleanup({ databaseConfigured: false, db: null, services: null })(OWNER, PROJECT.id))
      .resolves.toBeUndefined();
    // Core tables only partly there: a damaged schema is refused (and the deletion retried), never half erased.
    await sql`DROP TABLE brain_claims CASCADE`.execute(harness.db);
    await expect(eraseBrainProject(harness.db, OWNER, PROJECT.id)).rejects.toThrow("core tables are incomplete");
  });

  it("erases nothing for a malformed project id, and nothing where the brain never started", async () => {
    await seedLinear(harness);
    const before = await scopeRows(harness);
    expect(before).toBeGreaterThan(0);
    await eraseBrainProject(harness.db, OWNER, "../proj_widgets");
    expect(await scopeRows(harness)).toBe(before);
    const pglite = await KyselyPGlite.create();
    const bare = new Kysely<BrainDatabase>({ dialect: pglite.dialect });
    try {
      await expect(eraseBrainProject(bare, OWNER, PROJECT.id)).resolves.toBeUndefined();
      const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name LIKE 'brain\\_%'`.execute(bare);
      expect(rows[0]!.n).toBe(0);
    } finally {
      await bare.destroy();
    }
  });

  it("drops a removed source's people and text before answering, and never lists people of dead documents", async () => {
    const services = await start();
    const source = await seedLinear(harness);
    for (const index of services.indexes) await index.refresh(SCOPE, {}, AbortSignal.timeout(10_000));
    expect([await people(services), await hits(services, "roadmap")]).toEqual([["email:alice@acme.dev"], 1]);
    await services.sources!.remove(OWNER, "widgets", source.sourceId, source.revision);
    // Read first, before a queued change event could run: the purge itself already dropped the derived rows.
    const derived = await sql<{ n: number }>`SELECT (SELECT count(*) FROM brain_graph_links
        WHERE owner_id = ${OWNER} AND scope_id = ${SCOPE.scopeId})::int
      + (SELECT count(*) FROM brain_search_documents WHERE owner_id = ${OWNER} AND scope_id = ${SCOPE.scopeId})::int
      AS n`.execute(harness.db);
    expect(derived.rows[0]!.n).toBe(0);
    expect([await people(services), await hits(services, "roadmap")]).toEqual([[], 0]);

    // Removed straight in the store (no purge, no event): the entity list still leaves the person out.
    const again = await seedLinear(harness, "Another roadmap.");
    for (const index of services.indexes) await index.refresh(SCOPE, {}, AbortSignal.timeout(10_000));
    expect(await people(services)).toEqual(["email:alice@acme.dev"]);
    await harness.repository.deleteSource(SCOPE, { sourceId: again.sourceId, expectedRevision: again.revision });
    expect(await people(services)).toEqual([]);
  });

  it("indexes, at the next start, documents whose change event was dropped at shutdown", async () => {
    const first = await start();
    await seedLinear(harness);
    await stopBrainServices(first, 1_000);
    first.hooks.emit({ type: "documents_changed", scope: SCOPE, sourceId: null, documentIds: null, at: AT });
    expect(warn).toHaveBeenCalledWith("[brain-hooks] event after close dropped:", "documents_changed");
    const second = await start({ catchUpDelayMs: 0 });
    expect(await hits(second, "roadmap")).toBe(0);
    expect(second.jobs.map((job) => job.name)).toContain("brain-index-catch-up");
    for (const job of second.jobs) job.start();
    await vi.waitFor(async () => expect(await hits(second, "roadmap")).toBe(1), { timeout: 20_000, interval: 100 });
    await vi.waitFor(async () => expect(await people(second)).toEqual(["email:alice@acme.dev"]),
      { timeout: 20_000, interval: 100 });
    for (const index of second.indexes) expect((await index.freshness(SCOPE)).caughtUp).toBe(true);
  });

  it("names the project entity after the project, and keeps the stored name when the lookup fails", async () => {
    const services = await start();
    await seedLinear(harness);
    const graph = services.indexes.find((index) => index.name === "graph")!;
    await graph.refresh(SCOPE, {}, AbortSignal.timeout(10_000));
    const project = () => services.graph!.getEntity(OWNER, "widgets", `project:${PROJECT.id}`);
    expect(await project()).toMatchObject({ kind: "project", key: PROJECT.id, displayName: "Widgets" });
    const renamed = { ...PROJECT, name: "Widgets Two" };
    const lookup = vi.spyOn(projects, "getProjectById").mockResolvedValue({ ok: true, project: renamed });
    await graph.refresh(SCOPE, {}, AbortSignal.timeout(10_000));
    expect((await project()).displayName).toBe("Widgets Two");
    lookup.mockResolvedValue({ ok: false, status: 503, error: { code: "unavailable", message: "Down" } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await graph.refresh(SCOPE, {}, AbortSignal.timeout(10_000));
    expect(warn).toHaveBeenCalledWith("[brain-graph] project name unavailable:", "BrainApiError");
    lookup.mockRestore();
    expect((await project()).displayName).toBe("Widgets Two");
  });

  it("counts and logs a failing index without stopping the pass, and stops when aborted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await harness.repository.createSource(SCOPE, { kind: "linear", externalRef: "linear:eng", label: "L" });
    const index = (name: "search" | "graph", refresh: () => Promise<never> | Promise<object>) =>
      ({ name, handle: vi.fn(), refresh, freshness: vi.fn() }) as unknown as BrainDerivedIndex;
    const broken = index("search", async () => { throw new RangeError("down"); });
    const behind = index("graph", async () => ({ processed: 1, removed: 0, caughtUp: true }));
    expect(await runBrainIndexCatchUp(harness.db, [broken, behind], AbortSignal.timeout(10_000)))
      .toEqual({ scopes: 1, refreshed: 1, failed: 1 });
    expect(error).toHaveBeenCalledWith("[brain] index catch-up of search failed:", "RangeError");
    expect(await runBrainIndexCatchUp(harness.db, [behind], AbortSignal.abort()))
      .toEqual({ scopes: 0, refreshed: 0, failed: 0 });
    await sql`DROP TABLE brain_sources CASCADE`.execute(harness.db);
    expect(await runBrainIndexCatchUp(harness.db, [behind], AbortSignal.timeout(10_000)))
      .toEqual({ scopes: 0, refreshed: 0, failed: 1 });
    expect(error).toHaveBeenLastCalledWith("[brain] index catch-up could not list scopes:", expect.any(String));
    error.mockRestore();
  });

  it("bounds the scope list, refreshes caught-up indexes too and stops between indexes once aborted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await harness.repository.createSource(SCOPE, { kind: "linear", externalRef: "linear:eng", label: "L" });
    const other = brainProjectScope(OWNER, "proj_other");
    await harness.repository.createSource(other, { kind: "linear", externalRef: "linear:ops", label: "O" });
    expect(await listBrainSourceScopes(harness.db, 0)).toHaveLength(1);
    expect(await listBrainSourceScopes(harness.db, Number.NaN)).toHaveLength(1);
    expect(await listBrainSourceScopes(harness.db, 5)).toHaveLength(2);
    const caughtUp = async () => ({ caughtUp: true, pendingDocuments: 0, pendingCapped: false });
    const index = (name: "search" | "graph", refresh: () => Promise<object>) =>
      ({ name, handle: vi.fn(), refresh, freshness: vi.fn(caughtUp) }) as unknown as BrainDerivedIndex;
    // Freshness counts documents, not the entities a sweep cut short left, so a caught-up index is refreshed too.
    const refresh = vi.fn(async () => ({ processed: 0, removed: 0, caughtUp: true }));
    const fresh = index("graph", refresh);
    expect(await runBrainIndexCatchUp(harness.db, [fresh], AbortSignal.timeout(10_000)))
      .toEqual({ scopes: 2, refreshed: 2, failed: 0 });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fresh.freshness).not.toHaveBeenCalled();
    // A failure that is not an Error is logged by its type.
    const odd = index("search", async () => { throw "down"; });
    expect(await runBrainIndexCatchUp(harness.db, [odd], AbortSignal.timeout(10_000)))
      .toEqual({ scopes: 2, refreshed: 0, failed: 2 });
    expect(error).toHaveBeenCalledWith("[brain] index catch-up of search failed:", "string");
    // Aborted while the first index runs: no log for it, no later index, no later scope.
    error.mockClear();
    const controller = new AbortController();
    const stopping = index("search", async () => {
      controller.abort();
      throw new Error("stopped");
    });
    const later = vi.fn(async () => ({ processed: 0, removed: 0, caughtUp: true }));
    expect(await runBrainIndexCatchUp(harness.db, [stopping, index("graph", later)], controller.signal))
      .toEqual({ scopes: 1, refreshed: 0, failed: 1 });
    expect(later).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    // The default start delay: a stop before it fires runs nothing.
    const job = createBrainIndexCatchUp({ db: harness.db, indexes: [index("graph", later)] });
    job.start();
    await job.stop();
    expect(later).not.toHaveBeenCalled();
    // A source passed without a removal time purges by its last update, which tombstoned nothing.
    const { source } = await harness.repository.createSource(SCOPE, { kind: "linear", externalRef: "linear:x", label: "X" });
    const handle = vi.fn(async () => undefined);
    expect(await purgeBrainRemovedSource(harness.db, [{ name: "search", handle }], SCOPE, source)).toBe(true);
    expect(handle).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("starts the catch-up once, and stop() aborts a running pass and waits for it", async () => {
    await harness.repository.createSource(SCOPE, { kind: "linear", externalRef: "linear:eng", label: "L" });
    let seen: AbortSignal | null = null;
    const refresh = vi.fn((_scope: unknown, _limits: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      seen = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const index = { name: "search", handle: vi.fn(), refresh,
      freshness: async () => ({ caughtUp: false, pendingDocuments: 1, pendingCapped: false }) } as unknown as BrainDerivedIndex;
    const idle = createBrainIndexCatchUp({ db: harness.db, indexes: [index], startDelayMs: 60_000 });
    idle.start();
    await idle.stop();
    expect(refresh).not.toHaveBeenCalled();
    const job = createBrainIndexCatchUp({ db: harness.db, indexes: [index], startDelayMs: 0 });
    job.start();
    job.start();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1), { timeout: 10_000, interval: 20 });
    await job.stop();
    expect(seen!.aborted).toBe(true);
    await job.stop();
  });

  it("reports a removed source's purge as unfinished when a listener fails, and as done with no listener", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const source = await seedLinear(harness);
    const removed = await harness.repository.deleteSource(SCOPE, { sourceId: source.sourceId, expectedRevision: source.revision });
    expect(await purgeBrainRemovedSource(harness.db, [], SCOPE, removed)).toBe(true);
    const handle = vi.fn(async () => { throw new RangeError("listener down"); });
    expect(await purgeBrainRemovedSource(harness.db, [{ name: "search", handle }], SCOPE, removed)).toBe(false);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      type: "documents_changed", sourceId: source.sourceId, documentIds: [brainDocumentId("issue")],
    }), expect.any(AbortSignal));
    expect(error).toHaveBeenCalledWith("[brain] removed source purge stopped; the change event repairs it:", "RangeError");
    error.mockRestore();
  });
});
