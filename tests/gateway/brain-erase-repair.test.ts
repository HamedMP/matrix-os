/**
 * The project erase and the removed source purge over PGlite with the graph: a refresh already running when the
 * project is erased writes nothing back, and a purge drops the derived rows of every tombstoned document of the
 * removed source, whenever it was tombstoned, and leaves no person only that source named readable; the start's
 * catch-up finishes a sweep a shutdown cut short. A source connect, git registration, job enqueue or extraction that
 * resolved the project before its deletion creates no source, job or extraction run after the erase.
 */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eraseBrainProject, eraseBrainScopeRows } from "../../packages/gateway/src/brain/api/erase.js";
import { purgeBrainRemovedSource, runBrainIndexCatchUp } from "../../packages/gateway/src/brain/api/index-repair.js";
import { createBrainProjectService } from "../../packages/gateway/src/brain/api/service.js";
import { BrainApiError, type BrainProjectLookup } from "../../packages/gateway/src/brain/api/types.js";
import { BrainFeatureError, type BrainProjectResolver } from "../../packages/gateway/src/brain/contracts.js";
import type { BrainGraphTables } from "../../packages/gateway/src/brain/graph/index.js";
import { createBrainGraphIndex } from "../../packages/gateway/src/brain/graph/refresh.js";
import { deriveGraphDocument, withGraphLock } from "../../packages/gateway/src/brain/graph/store.js";
import {
  BrainJobStore, bootstrapBrainJobsDatabase, createBrainJobsService,
} from "../../packages/gateway/src/brain/jobs/index.js";
import { createBrainSourcesService, runBrainSourceSync } from "../../packages/gateway/src/brain/sources/core/index.js";
import { fakeHandler, gate, SCOPE_A, sourcesHarness, type SourcesHarness } from "./helpers/brain-sources-fixture.js";
import {
  OWNER, PROJECT, SCOPE, createGraphHarness, id, rejectsWith, seedProject, type GraphHarness,
} from "./helpers/brain-graph-fixtures.js";

const GRAPH_TABLES = ["brain_graph_entities", "brain_graph_links", "brain_graph_state", "brain_graph_aliases"] as const;
const DANA = "person:email:dana@acme.dev";

describe("brain erase and removed source purge", { timeout: 60_000 }, () => {
  let harness: GraphHarness;
  beforeEach(async () => { harness = await createGraphHarness(); });
  afterEach(() => harness.destroy());

  const rows = async (table: string, documentId?: string) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n
    FROM ${sql.table(table)} WHERE owner_id = ${SCOPE.ownerId} AND scope_id = ${SCOPE.scopeId}
      ${documentId === undefined ? sql`` : sql`AND document_id = ${documentId}`}`.execute(harness.db)).rows[0]!.n);

  async function removeLinear() {
    const source = (await harness.repository.getSource(SCOPE, harness.sources.linear))!;
    harness.tick();
    return harness.repository.deleteSource(SCOPE, { sourceId: source.sourceId, expectedRevision: source.revision });
  }

  it("leaves no graph row when a refresh waiting on the project name resumes after the erase", async () => {
    await seedProject(harness);
    let release: (name: string) => void = () => undefined;
    const lookup = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const index = createBrainGraphIndex({
      db: harness.db.withTables<BrainGraphTables>(), now: harness.now, projectName: lookup,
    });
    const refreshing = index.refresh(SCOPE, {}, new AbortController().signal);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    await eraseBrainScopeRows(harness.db, SCOPE);
    release("Widgets");
    await refreshing;
    expect(await Promise.all(GRAPH_TABLES.map((table) => rows(table)))).toEqual([0, 0, 0, 0]);
  });

  it("purges documents of the removed source that were tombstoned before it, whose change event was lost", async () => {
    await seedProject(harness);
    // The comment is tombstoned by a sync whose change event never reached the graph.
    await harness.sync("linear", [], [id("comment")]);
    expect(await rows("brain_graph_state", id("comment"))).toBe(1);
    const removed = await removeLinear();
    expect(await purgeBrainRemovedSource(harness.db, [harness.graph.index], SCOPE, removed)).toBe(true);
    expect([await rows("brain_graph_state", id("comment")), await rows("brain_graph_links", id("comment"))])
      .toEqual([0, 0]);
    expect([await rows("brain_graph_state", id("issue")), await rows("brain_graph_links", id("issue"))])
      .toEqual([0, 0]);
  });

  it("leaves no person of the removed source readable once the purge reports done", async () => {
    await seedProject(harness);
    expect(await harness.graph.service.getEntity(OWNER, PROJECT, DANA)).toMatchObject({ kind: "person" });
    const removed = await removeLinear();
    expect(await purgeBrainRemovedSource(harness.db, [harness.graph.index], SCOPE, removed)).toBe(true);
    await rejectsWith(harness.graph.service.getEntity(OWNER, PROJECT, DANA), BrainFeatureError, "entity_not_found");
    // People other sources still name stay.
    expect(await harness.graph.service.getEntity(OWNER, PROJECT, "person:github:carol"))
      .toMatchObject({ kind: "person" });
  });

  it("catches up a graph whose sweep a shutdown cut short, with no document left pending", async () => {
    await seedProject(harness);
    await harness.sync("linear", [], [id("comment")]);
    // A hook removed the comment's rows, then the shutdown aborted it before its sweep.
    await withGraphLock(harness.db.withTables<BrainGraphTables>(), SCOPE,
      (trx) => deriveGraphDocument(trx, SCOPE, id("comment"), harness.now(), 1_000));
    expect(await harness.graph.service.getEntity(OWNER, PROJECT, DANA)).toMatchObject({ kind: "person" });
    expect((await harness.graph.index.freshness(SCOPE)).pendingDocuments).toBe(0);
    const signal = new AbortController().signal;
    expect(await runBrainIndexCatchUp(harness.db, [harness.graph.index], signal))
      .toEqual({ scopes: 1, refreshed: 1, failed: 0 });
    await rejectsWith(harness.graph.service.getEntity(OWNER, PROJECT, DANA), BrainFeatureError, "entity_not_found");
  });
});

describe("source, job and extraction run creation racing a project deletion", { timeout: 60_000 }, () => {
  let harness: SourcesHarness;
  let deleted: boolean;
  beforeEach(async () => { harness = await sourcesHarness(); deleted = false; });
  afterEach(async () => { await harness.destroy(); vi.restoreAllMocks(); });

  /** As project deletion does: the project stops resolving, then its brain is erased. */
  async function deleteProject() {
    deleted = true;
    await eraseBrainProject(harness.db, OWNER, "proj_a");
  }
  const scopeRows = async (table: string) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n
    FROM ${sql.table(table)} WHERE owner_id = ${SCOPE_A.ownerId} AND scope_id = ${SCOPE_A.scopeId}`
    .execute(harness.db)).rows[0]!.n);
  const sourceRows = () => scopeRows("brain_sources");
  /** The project lookup of the project API: proj_a until it is deleted. */
  const projects = {
    getProjectById: async () => deleted
      ? { ok: false, status: 404, error: { code: "not_found", message: "Project was not found" } }
      : { ok: true, project: { id: "proj_a", slug: "alpha", name: "Alpha" } },
  } as unknown as BrainProjectLookup;

  it("connects no source when the project is deleted while the connect waits on its config check", async () => {
    const checking = gate();
    const checked = gate();
    const handler = fakeHandler("linear", { checkConfig: async () => { checked.open(); await checking.wait; } });
    const resolver: BrainProjectResolver = {
      ...harness.resolver,
      resolve: async (ownerId, projectRef) => {
        if (deleted) throw new BrainApiError("project_not_found");
        return harness.resolver.resolve(ownerId, projectRef);
      },
    };
    const sources = createBrainSourcesService({
      repository: harness.repository, resolver, handlers: [handler], runner: runBrainSourceSync,
    });
    const connecting = sources.connect(OWNER, "proj_a", { kind: "linear", config: { items: ["x"] } });
    await checked.wait;
    await deleteProject();
    checking.open();
    await rejectsWith(connecting, BrainApiError, "project_not_found");
    expect(await sourceRows()).toBe(0);
    expect(handler.calls).not.toContain("save");
  });

  it("registers no git source when the project is deleted while the registration looks for one", async () => {
    const listSources = harness.repository.listSources.bind(harness.repository);
    vi.spyOn(harness.repository, "listSources").mockImplementationOnce(async (scope, options) => {
      const page = await listSources(scope, options);
      await deleteProject();
      return page;
    });
    const project = createBrainProjectService({ repository: harness.repository, projects, homePath: "/home" });
    await rejectsWith(project.registerGitSource(OWNER, "proj_a", {}), BrainApiError, "project_not_found");
    expect(await sourceRows()).toBe(0);
  });

  it("queues no job when the project is deleted while the enqueue waits for the job lock", async () => {
    await bootstrapBrainJobsDatabase(harness.db);
    const resolver: BrainProjectResolver = {
      ...harness.resolver,
      resolve: async (ownerId, projectRef) => {
        if (deleted) throw new BrainApiError("project_not_found");
        const project = await harness.resolver.resolve(ownerId, projectRef);
        // The deletion finishes after the request resolved the project, before the store takes the job lock.
        await deleteProject();
        return project;
      },
    };
    const wake = vi.fn();
    const jobs = createBrainJobsService({ store: new BrainJobStore(harness.db), resolver, kinds: ["sync"], wake });
    await rejectsWith(jobs.enqueue(OWNER, "proj_a", { kind: "sync" }), BrainApiError, "project_not_found");
    expect(await scopeRows("brain_jobs")).toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });

  it("opens no extraction run when the project is deleted while the extract waits on its model", async () => {
    const model = { extract: vi.fn() };
    // The deletion finishes while the request reads the model configuration, after it resolved the project.
    const claimModels = async () => {
      await deleteProject();
      return { model, modelId: "claude-test", promptVersion: "v1", limits: {} };
    };
    const project = createBrainProjectService({
      repository: harness.repository, projects, homePath: "/home", claimModels,
    });
    await rejectsWith(project.extract(OWNER, "proj_a", { extractor: "model" }), BrainApiError, "project_not_found");
    expect(await scopeRows("brain_extraction_runs")).toBe(0);
    expect(model.extract).not.toHaveBeenCalled();
  });
});
