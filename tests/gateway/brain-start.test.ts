/**
 * Starting every Company Brain feature on one owner database: bootstrap order and deferral, the services bag, the
 * change events of the project service, shutdown, and the shared project resolver.
 */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createBrainApiRoutes, createBrainProjectResolver, resolveBrainAgentOwnerId, startBrainServices, stopBrainServices,
  withBrainChangeEvents, type BrainServicesHandle,
} from "../../packages/gateway/src/brain/api/index.js";
import {
  BrainApiError, brainProjectScope, type BrainProjectLookup, type BrainProjectService,
} from "../../packages/gateway/src/brain/api/types.js";
import type {
  BrainBackgroundJob, BrainChangeEvent, BrainProjectResolver, BrainServices,
} from "../../packages/gateway/src/brain/contracts.js";
import { BrainRepository } from "../../packages/gateway/src/brain/index.js";
import type { ProjectConfig } from "../../packages/gateway/src/project-manager.js";
import type { OwnerScope } from "../../packages/gateway/src/state-ops.js";
import { createSeeder, seedClaims } from "./helpers/brain-search-fakes.js";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";

/** A brief bootstrap that throws this instead (an error without a SQLSTATE); null runs the real one. */
const briefBootstrap = vi.hoisted(() => ({ fail: null as unknown }));
vi.mock("../../packages/gateway/src/brain/brief/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/brain/brief/index.js")>();
  return {
    ...actual,
    bootstrapBrainBriefDatabase: async (...args: Parameters<typeof actual.bootstrapBrainBriefDatabase>) => {
      if (briefBootstrap.fail !== null) throw briefBootstrap.fail;
      return actual.bootstrapBrainBriefDatabase(...args);
    },
  };
});

const OWNER = "owner_a";
/** No model claims: start never builds a client from the environment in these tests. */
const noModel = async () => null;
const AT = "2026-10-01T10:00:00.000Z";
const PROJECT: ProjectConfig = {
  id: "proj_widgets", name: "Widgets", slug: "widgets", kind: "folder", localPath: "/home/widgets", addedAt: AT,
  updatedAt: AT, ownerScope: { type: "user", id: OWNER },
};

type LookupResult = Awaited<ReturnType<BrainProjectLookup["getProjectById"]>>;

function lookup(failStatus?: number) {
  const answer = (scope: OwnerScope | undefined, matches: boolean): LookupResult => {
    const status = failStatus ?? (matches && scope?.type === "user" && scope.id === OWNER ? 200 : 404);
    return status === 200 ? { ok: true, project: PROJECT }
      : { ok: false, status, error: { code: "not_found", message: "Project was not found" } };
  };
  return {
    getProjectById: vi.fn<BrainProjectLookup["getProjectById"]>(async (scope, id) => answer(scope, id === PROJECT.id)),
    getProject: vi.fn<BrainProjectLookup["getProject"]>(async (slug, scope) => answer(scope, slug === PROJECT.slug)),
    resolveProjectWorkingDirectory: vi.fn<BrainProjectLookup["resolveProjectWorkingDirectory"]>(async () => "/home/widgets"),
  };
}

const FEATURE_TABLES = [
  "brain_search_documents", "brain_search_claims", "brain_graph_entities", "brain_graph_links", "brain_brief_briefs",
  "brain_github_sources", "brain_matrix_sources", "brain_connector_sources", "brain_jobs",
];

/** Rows of `scope` across every brain_* table that has a scope_id column. */
async function scopeRows(harness: BrainHarness, scope: { ownerId: string; scopeId: string }): Promise<number> {
  const { rows } = await sql<{ table_name: string }>`SELECT DISTINCT table_name FROM information_schema.columns
    WHERE table_name LIKE 'brain_%' AND column_name = 'scope_id'`.execute(harness.db);
  let total = 0;
  for (const { table_name: table } of rows) {
    const counted = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}
      WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}`.execute(harness.db);
    total += counted.rows[0]!.n;
  }
  return total;
}

describe("startBrainServices", { timeout: 60_000 }, () => {
  let harness: BrainHarness;
  let warn: MockInstance<typeof console.warn>;
  let started: BrainServicesHandle | null = null;
  beforeEach(async () => {
    harness = await createBrainHarness();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await stopBrainServices(started, 1_000);
    started = null;
    warn.mockRestore();
    vi.restoreAllMocks();
    await harness.destroy();
  });

  it("bootstraps every feature and returns the services bag with the listeners and the brief job", async () => {
    started = await startBrainServices(harness.db, {
      projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: OWNER,
    });
    expect(started).not.toBeNull();
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'brain_%'`.execute(harness.db);
    const names = tables.rows.map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining(FEATURE_TABLES));
    const services = started!;
    expect([services.search, services.graph, services.sources, services.brief, services.impact, services.runs]
      .every((s) => s !== null)).toBe(true);
    expect(services.searchCapability).toEqual({ fullText: true, vector: "extension_missing", providerId: null });
    expect(services.indexes.map((index) => index.name)).toEqual(["search", "graph"]);
    // The run worker comes first: it is started with the others and stopped before them.
    expect(services.jobs.map((job) => job.name)).toEqual(["brain-jobs", "brain-brief", "brain-index-catch-up"]);
    expect(await services.project.listReceipts(OWNER, "widgets", 1)).toEqual({ source: null, receipts: [] });
    expect(await services.search!.search(OWNER, "widgets", { q: "anything", limit: 5 })).toMatchObject({ items: [] });

    const again = await startBrainServices(harness.db, {
      projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: null,
    });
    expect(again?.jobs.map((job) => job.name)).toEqual(["brain-index-catch-up"]);
    // No owner to run for: no worker, and every kind of run is unavailable, so clients run the work directly.
    await expect(again!.runs!.enqueue(OWNER, "widgets", { kind: "sync" })).rejects.toMatchObject({
      code: "job_kind_unavailable",
    });
    await stopBrainServices(again, 1_000);

    // Defaults: model settings from the environment (read, never called here) and the gateway owner's schedule.
    const defaults = await startBrainServices(harness.db, { projects: lookup(), homePath: "/home" });
    expect(defaults?.jobs).toHaveLength(resolveBrainAgentOwnerId() === null ? 1 : 3);
    await stopBrainServices(defaults, 1_000);
  });

  it("leaves only the failing feature off, whatever its error, and keeps project, search, brief and impact", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sql`CREATE TABLE brain_graph_entities (unrelated INTEGER)`.execute(harness.db);
    started = await startBrainServices(harness.db, {
      projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: OWNER,
    });
    const services = started!;
    expect(services.graph).toBeNull();
    expect([services.search, services.brief, services.impact].every((s) => s !== null)).toBe(true);
    expect(services.indexes.map((index) => index.name)).toEqual(["search"]);
    expect(services.jobs.map((job) => job.name)).toEqual(["brain-jobs", "brain-brief", "brain-index-catch-up"]);
    expect(error).toHaveBeenCalledWith("[brain] graph is off after its start failed:", expect.any(String), "42703");
    expect(await services.project.listReceipts(OWNER, "widgets", 1)).toEqual({ source: null, receipts: [] });
    expect(await services.search!.search(OWNER, "widgets", { q: "anything", limit: 5 })).toMatchObject({ items: [] });
    expect(await services.brief!.conflicts(OWNER, "widgets", {})).toMatchObject({ items: [] });
    error.mockRestore();
  });

  it("starts with every feature with tables off when their bootstraps fail; no integrations answer unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sql`CREATE TABLE brain_search_documents (unrelated INTEGER)`.execute(harness.db);
    await sql`CREATE TABLE brain_graph_entities (unrelated INTEGER)`.execute(harness.db);
    briefBootstrap.fail = new Error("no code");
    try {
      started = await startBrainServices(harness.db, {
        projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: OWNER,
        sources: { limits: { pagesPerRun: 1 } },
      });
    } finally {
      briefBootstrap.fail = null;
    }
    const services = started!;
    expect([services.search, services.graph, services.brief, services.searchCapability]).toEqual([null, null, null, null]);
    expect(services.indexes).toEqual([]);
    expect(services.jobs.map((job) => job.name)).toEqual(["brain-jobs"]);
    expect(services.impact).not.toBeNull();
    expect(error).toHaveBeenCalledWith("[brain] search is off after its start failed:", expect.any(String), "42703");
    expect(error).toHaveBeenCalledWith("[brain] brief is off after its start failed:", "Error", "");
    // Without an integration caller the GitHub probe answers unavailable: the kind is not configured.
    const kinds = new Map((await services.sources!.list(OWNER, "widgets")).kinds.map((view) => [view.kind, view]));
    expect(kinds.get("github")).toEqual({ kind: "github", available: false, reason: "not_configured" });
    await services.eraseProject(OWNER, PROJECT.id);
    await stopBrainServices(started, 1_000);
    briefBootstrap.fail = "plain text";
    try {
      started = await startBrainServices(harness.db, {
        projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: null,
      });
    } finally {
      briefBootstrap.fail = null;
    }
    expect(started!.brief).toBeNull();
    expect(error).toHaveBeenLastCalledWith("[brain] brief is off after its start failed:", "string", "");
    error.mockRestore();
  });

  it("starts the sources service with a handler per kind and the integration seams it is given", async () => {
    const isConnected = vi.fn(async (_owner: string, service: string) => service === "linear");
    started = await startBrainServices(harness.db, {
      projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: null,
      sources: { isConnected, accounts: async () => ["eng"], notes: null, chats: null },
    });
    const kinds = new Map((await started!.sources!.list(OWNER, "widgets")).kinds.map((view) => [view.kind, view]));
    expect([...kinds.keys()].sort()).toEqual([
      "git", "github", "google_calendar", "google_drive", "linear", "matrix_chat", "matrix_files", "matrix_notes",
      "slack_bridge",
    ]);
    // git syncs through the project service; linear and drive answer from the seams; no reader turns a kind off.
    expect(kinds.get("git")).toEqual({ kind: "git", available: true, reason: null });
    expect(kinds.get("linear")).toEqual({ kind: "linear", available: true, reason: null });
    expect(kinds.get("google_drive")).toEqual({ kind: "google_drive", available: false, reason: "not_connected" });
    for (const off of ["matrix_notes", "matrix_chat", "slack_bridge"]) {
      expect(kinds.get(off as never)).toMatchObject({ available: false, reason: "not_configured" });
    }
    expect(isConnected).toHaveBeenCalledWith(OWNER, "linear");
  });

  it("leaves only the source kinds of a failed table group off and keeps the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sql`CREATE TABLE brain_github_sources (unrelated INTEGER)`.execute(harness.db);
    started = await startBrainServices(harness.db, {
      projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: null,
      sources: { isConnected: async () => true },
    });
    const kinds = new Map((await started!.sources!.list(OWNER, "widgets")).kinds.map((view) => [view.kind, view]));
    expect(kinds.get("github")).toEqual({ kind: "github", available: false, reason: "not_configured" });
    expect(kinds.get("linear")).toEqual({ kind: "linear", available: true, reason: null });
    expect(kinds.get("git")?.available).toBe(true);
    expect(started!.search).not.toBeNull();
    expect(error.mock.calls.some((call) => String(call[0]).includes("github"))).toBe(true);
    error.mockRestore();
  });

  it("erases a deleted project's whole scope, derived rows and stored briefs included, and nothing else", async () => {
    started = await startBrainServices(harness.db, {
      projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: null,
    });
    const services = started!;
    const scope = brainProjectScope(OWNER, PROJECT.id);
    const other = brainProjectScope(OWNER, "proj_other");
    for (const target of [scope, other]) {
      const seeder = await createSeeder(harness, target);
      await seeder.sync([{ seed: "alpha", body: "We decided to keep it small.", refs: [{ kind: "path", value: "a.ts" }] }]);
      await seedClaims(harness, "alpha", [{ kind: "decision", statement: "Keep it small.", quote: "keep it small" }],
        "rules/v1", target);
      for (const index of services.indexes) await index.refresh(target, {}, AbortSignal.timeout(10_000));
      // A connected source's own config row goes with its brain_sources row.
      const { source } = await harness.repository.createSource(target, { kind: "linear", externalRef: "linear:eng", label: "L" });
      await sql`INSERT INTO brain_connector_sources (owner_id, scope_id, source_id, kind, config, updated_at)
        VALUES (${target.ownerId}, ${target.scopeId}, ${source.sourceId}, 'linear', '{}'::jsonb, now())`.execute(harness.db);
    }
    expect((await services.brief!.getBrief(OWNER, "widgets", {})).stored).toBe(true);
    const before = await scopeRows(harness, other);
    expect(await scopeRows(harness, scope)).toBeGreaterThan(5);
    await services.eraseProject(OWNER, PROJECT.id);
    await services.eraseProject(OWNER, "../not-a-project");
    expect(await scopeRows(harness, scope)).toBe(0);
    expect(await scopeRows(harness, other)).toBe(before);
  });

  it("starts the run worker with the services: a queued run goes through the mounted routes and finishes", async () => {
    started = await startBrainServices(harness.db, {
      projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: OWNER,
      jobWorkerLimits: { pollMs: 20, stepPauseMs: 0 },
    });
    const services = started!;
    const as = (userId: string) => createBrainApiRoutes(services, () => ({ userId, source: "dev-default" }) as never);
    const post = (app: ReturnType<typeof as>, path: string, body: unknown) => app.request(path, {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    });
    const queued = await post(as(OWNER), "/projects/widgets/jobs", { kind: "search_refresh" });
    expect(queued.status).toBe(202);
    const { job } = await queued.json() as { job: { jobId: string; status: string } };
    expect(job.status).toBe("queued");
    // Only start() runs it, as server.ts does after the server listens.
    services.jobs.find((entry) => entry.name === "brain-jobs")!.start();
    let status = job.status;
    for (let tries = 0; tries < 200 && status !== "succeeded" && status !== "failed"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const read = await as(OWNER).request(`/projects/widgets/jobs/${job.jobId}`);
      status = ((await read.json()) as { status: string }).status;
    }
    expect(status).toBe("succeeded");
    const listed = await (await as(OWNER).request("/projects/widgets/jobs?limit=5")).json() as { jobs: unknown[] };
    expect(listed.jobs).toEqual([expect.objectContaining({ jobId: job.jobId, kind: "search_refresh", steps: 1 })]);
    // Another owner's run would never be claimed by this gateway's worker.
    const foreign = await post(as("owner_b"), "/projects/widgets/jobs", { kind: "search_refresh" });
    expect(await foreign.json()).toEqual({
      error: { code: "job_kind_unavailable", message: "This kind of run is not available" },
    });
  });

  it("leaves only the background runs off when brain_jobs cannot be bootstrapped", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sql`CREATE TABLE brain_jobs (unrelated INTEGER)`.execute(harness.db);
    started = await startBrainServices(harness.db, { projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: OWNER });
    const services = started!;
    expect(services.runs).toBeNull();
    expect(services.jobs.map((job) => job.name)).toEqual(["brain-brief", "brain-index-catch-up"]);
    expect([services.search, services.graph, services.sources, services.brief].every((s) => s !== null)).toBe(true);
    expect(error).toHaveBeenCalledWith("[brain] jobs is off after its start failed:", expect.any(String), "42703");
    const routes = createBrainApiRoutes(services, () => ({ userId: OWNER, source: "dev-default" }) as never);
    // job_kind_unavailable: the app falls back to the direct routes, which still answer.
    const post = (path: string, body: unknown) => routes.request(path, {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const queued = await post("/projects/widgets/jobs", { kind: "sync" });
    expect([queued.status, ((await queued.json()) as { error: { code: string } }).error.code])
      .toEqual([409, "job_kind_unavailable"]);
    expect(await (await routes.request("/projects/widgets/jobs")).json()).toEqual({ jobs: [] });
    const run = `/projects/widgets/jobs/job_${"a".repeat(32)}`;
    expect([(await routes.request(run)).status, (await post(`${run}/cancel`, {})).status]).toEqual([404, 404]);
    expect((await routes.request("/projects/widgets/receipts")).status).toBe(200);
    const off = createBrainApiRoutes(null, () => ({ userId: OWNER, source: "dev-default" }) as never);
    expect((await off.request("/projects/widgets/jobs")).status).toBe(503); // the whole brain off: still 503
    error.mockRestore();
  });

  it("defers the whole brain on a core bootstrap deadline and leaves it off on any other core error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bootstrap = vi.spyOn(BrainRepository.prototype, "bootstrap");
    const deps = { projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: null };
    for (const code of ["55P03", "57014"]) {
      bootstrap.mockRejectedValueOnce(Object.assign(new Error("deadline"), { code }));
      expect(await startBrainServices(harness.db, deps)).toBeNull();
      expect(warn).toHaveBeenLastCalledWith("[brain] bootstrap deferred after a database deadline:", code);
    }
    // A missing privilege or anything else: the brain is off, owner startup (chats, canvas) goes on.
    for (const failure of [Object.assign(new Error("denied"), { code: "42501" }), "plain text"]) {
      bootstrap.mockRejectedValueOnce(failure);
      await expect(startBrainServices(harness.db, deps)).resolves.toBeNull();
    }
    expect(error).toHaveBeenCalledWith("[brain] the brain is off after its core start failed:", "Error", "42501");
    expect(error).toHaveBeenLastCalledWith("[brain] the brain is off after its core start failed:", "string", "");
    error.mockRestore();
  });

  it("leaves the brain off, without throwing, when an older table clashes with a core table", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sql`DROP TABLE brain_documents CASCADE`.execute(harness.db);
    await sql`CREATE TABLE brain_documents (unrelated INTEGER)`.execute(harness.db);
    started = await startBrainServices(harness.db, {
      projects: lookup(), homePath: "/home", claimModels: noModel, scheduleOwnerId: null,
    });
    expect(started).toBeNull();
    expect(error).toHaveBeenCalledWith("[brain] the brain is off after its core start failed:", expect.any(String),
      expect.stringMatching(/^[0-9A-Z]{5}$/));
    error.mockRestore();
  });

  it("stops the run worker first, then every other job, logs a failed stop by name, then drains the hooks", async () => {
    const order: string[] = [];
    let workerStopped = false;
    const job = (name: string, fail = false): BrainBackgroundJob => ({
      name, start: () => undefined,
      stop: async () => {
        // The other jobs only stop once the worker's stop has finished (it waits for its runs).
        order.push(name === "brain-jobs" || workerStopped ? name : `${name}:early`);
        if (name === "brain-jobs") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          workerStopped = true;
        }
        if (fail) throw new RangeError("stop failed");
      },
    } as BrainBackgroundJob);
    const services = {
      jobs: [job("a"), job("brain-jobs"), job("b", true)],
      hooks: { emit: vi.fn(), close: vi.fn(async (deadline: number) => { order.push(`close:${deadline}`); }) },
    } as unknown as BrainServices;
    await stopBrainServices(services);
    expect(order).toEqual(["brain-jobs", "a", "b", "close:5000"]);
    expect(warn).toHaveBeenCalledWith("[brain] job stop failed:", "RangeError");
    await expect(stopBrainServices(null)).resolves.toBeUndefined();
  });
});
