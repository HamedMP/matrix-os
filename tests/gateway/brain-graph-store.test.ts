/** The graph over PGlite: derivation from synced documents and claims, timelines, entities, aliases and cleanup. */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainApiError } from "../../packages/gateway/src/brain/api/types.js";
import { BrainFeatureError, type BrainTimelineView } from "../../packages/gateway/src/brain/contracts.js";
import {
  bootstrapBrainGraphDatabase, createBrainGraph, type BrainGraphTables,
} from "../../packages/gateway/src/brain/graph/index.js";
import { createBrainGraphIndex } from "../../packages/gateway/src/brain/graph/refresh.js";
import {
  FIXTURE, OWNER, PROJECT, SCOPE, createGraphHarness, id, rejectsWith, resolver, seedProject, type GraphHarness,
} from "./helpers/brain-graph-fixtures.js";

const labels = (view: BrainTimelineView) => view.items.map((item) => item.cite.documentId);
const GRAPH_TABLES = ["brain_graph_entities", "brain_graph_links", "brain_graph_state", "brain_graph_aliases"] as const;

describe("brain graph store", { timeout: 60_000 }, () => {
  let harness: GraphHarness;
  beforeEach(async () => { harness = await createGraphHarness(); });
  afterEach(() => harness.destroy());

  const service = () => harness.graph.service;
  const timeline = (entity: string, query: Record<string, unknown> = {}) =>
    service().timeline(OWNER, PROJECT, { entity, ...query });
  const count = async (table: (typeof GRAPH_TABLES)[number]) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n
    FROM ${sql.table(table)} WHERE owner_id = ${SCOPE.ownerId} AND scope_id = ${SCOPE.scopeId}`.execute(harness.db)).rows[0]!.n);

  it("bootstraps idempotently and derives every live document", async () => {
    await bootstrapBrainGraphDatabase(harness.db);
    await seedProject(harness);
    const fresh = await harness.graph.index.freshness(SCOPE);
    expect(fresh).toEqual({ caughtUp: true, pendingDocuments: 0, pendingCapped: false });
    expect(await count("brain_graph_state")).toBe(7);
    expect(await harness.refresh()).toEqual({ processed: 0, removed: 0, caughtUp: true });
  });

  it("answers file, folder, person, pull request, spec and issue timelines newest first", async () => {
    await seedProject(harness);
    const file = await timeline("file:src/alpha.ts");
    expect(labels(file)).toEqual([id("spec"), id("commitB"), id("pr12")]);
    expect(file.items.map((item) => [item.linkTypes, item.mode, item.matchedPaths])).toEqual([
      [["decided_in"], "inferred", []], [["changed"], "explicit", ["src/alpha.ts"]],
      [["changed"], "explicit", ["src/alpha.ts"]],
    ]);
    expect(file.items[2]!.cite).toMatchObject({ kind: "pr", label: "#12", title: "feat: alpha" });
    expect(file.items[1]!.cite.label).toBe("b".repeat(12));
    expect(labels(await timeline("folder:src"))).toEqual([id("commitB"), id("pr12")]);
    const person = await timeline("person:email:alice@acme.dev");
    expect(labels(person)).toEqual([id("issue"), id("commitB"), id("pr12")]);
    expect((await timeline("person:name:alice smith")).entity.key).toBe("email:alice@acme.dev");
    const pr = await timeline("pull_request:12");
    expect(labels(pr)).toEqual([id("review"), id("githubPr"), id("spec"), id("commitB"), id("pr12")]);
    expect(pr.items.map((item) => item.linkTypes)).toEqual([
      ["part_of"], ["describes"], ["mentions", "decided_in"], ["part_of"], ["describes"],
    ]);
    expect(pr.items[1]!.cite.label).toBe("#12");
    expect(labels(await timeline("spec:specs/001-alpha"))).toEqual([id("spec"), id("pr12")]);
    const issue = await timeline("issue:ENG-42");
    expect(labels(issue)).toEqual([id("comment"), id("issue"), id("githubPr")]);
    expect(issue.items[1]!.cite).toMatchObject({ kind: "issue", label: "ENG-42" });
    expect(labels(await timeline("issue:#9"))).toEqual([id("pr12")]);
  });

  it("filters timelines by link type and date range and pages with cursors bound to the query", async () => {
    await seedProject(harness);
    expect(labels(await timeline("pull_request:12", { linkTypes: ["describes"] }))).toEqual([id("githubPr"), id("pr12")]);
    expect(labels(await timeline("file:src/alpha.ts", { linkTypes: ["changed"] }))).toEqual([id("commitB"), id("pr12")]);
    expect((await timeline("pull_request:12", { linkTypes: ["changed"] })).items).toEqual([]);
    expect(labels(await timeline("pull_request:12", { from: "2026-09-02", to: "2026-09-04T10:00:00Z" })))
      .toEqual([id("spec"), id("commitB")]);
    const first = await timeline("pull_request:12", { limit: 2 });
    expect(labels(first)).toEqual([id("review"), id("githubPr")]);
    const second = await timeline("pull_request:12", { limit: 2, cursor: first.nextCursor! });
    expect(labels(second)).toEqual([id("spec"), id("commitB")]);
    const third = await timeline("pull_request:12", { limit: 2, cursor: second.nextCursor! });
    expect([labels(third), third.nextCursor]).toEqual([[id("pr12")], null]);
    await rejectsWith(timeline("pull_request:7", { cursor: first.nextCursor! }), BrainApiError, "invalid_request");
    await rejectsWith(timeline("pull_request:12", { cursor: "!!" }), BrainApiError, "invalid_request");
    await rejectsWith(timeline("pull_request:12", { from: "2026-13-01" }), BrainApiError, "invalid_request");
    await rejectsWith(timeline("pull_request:12", { limit: 51 }), BrainApiError, "invalid_request");
    await rejectsWith(timeline("nonsense"), BrainApiError, "invalid_request");
    await rejectsWith(timeline("pull_request:999"), BrainFeatureError, "entity_not_found");
    await rejectsWith(service().timeline(OWNER, "proj_other", { entity: "pull_request:12" }), BrainApiError,
      "project_not_found");
  });

  it("re-derives revised, tombstoned and claim-changed documents through hooks and refresh", async () => {
    await seedProject(harness);
    const signal = new AbortController().signal;
    const at = harness.iso();
    // A tombstone keeps the document row, so only the listener or refresh removes its graph rows.
    await harness.sync("git", [], [id("commitB")]);
    expect((await harness.graph.index.freshness(SCOPE)).pendingDocuments).toBe(1);
    await harness.graph.index.handle({ type: "documents_changed", scope: SCOPE, sourceId: null,
      documentIds: [id("commitB"), id("commitB"), "not-an-id", "f".repeat(64)], at }, signal);
    expect(labels(await timeline("file:src/alpha.ts"))).toEqual([id("spec"), id("pr12")]);
    expect(await count("brain_graph_state")).toBe(6);
    // Alice's name is still seen with one email (pr12), so the merge stands; then pr12 goes too.
    expect((await timeline("person:name:alice smith")).entity.key).toBe("email:alice@acme.dev");
    await harness.sync("git", [], [id("pr12")]);
    expect(await harness.refresh()).toEqual({ processed: 0, removed: 1, caughtUp: true });
    await rejectsWith(timeline("person:name:alice smith"), BrainFeatureError, "entity_not_found");
    await rejectsWith(timeline("person:name:bob jones"), BrainFeatureError, "entity_not_found");
    // A revision is re-derived by id; claims_changed with null ids refreshes what the decision digest changed.
    await harness.sync("git", [{ ...FIXTURE.spec, body: `${FIXTURE.spec.body}
- Decision: drop #40.` }]);
    await harness.graph.index.handle({ type: "documents_changed", scope: SCOPE, sourceId: null,
      documentIds: [id("spec")], at }, signal);
    expect(labels(await timeline("pull_request:40"))).toEqual([id("spec")]);
    expect((await timeline("file:src/alpha.ts", { linkTypes: ["decided_in"] })).items).toEqual([]);
    await harness.decide(id("spec"), "Decision: drop #40.");
    expect((await harness.graph.index.freshness(SCOPE)).pendingDocuments).toBe(1);
    await harness.graph.index.handle({ type: "claims_changed", scope: SCOPE, extractor: "rules/v1", documentIds: null,
      at }, signal);
    expect((await timeline("pull_request:40")).items[0]!.linkTypes).toEqual(["mentions", "decided_in"]);
  });

  it("removes the rows of a dependent tombstoned after a hook marked it outdated", async () => {
    await harness.sync("git", [FIXTURE.commitB]);
    await harness.refresh();
    await harness.sync("github", [FIXTURE.githubPr]);
    await harness.graph.index.handle({ type: "documents_changed", scope: SCOPE, sourceId: null,
      documentIds: [id("githubPr")], at: harness.iso() }, new AbortController().signal);
    await harness.sync("git", [], [id("commitB")]);
    expect(await harness.refresh()).toEqual({ processed: 0, removed: 1, caughtUp: true });
    // Its document entity and its authored links are gone, so the sweep removed the person only it named.
    await rejectsWith(service().getEntity(OWNER, PROJECT, `document:${id("commitB")}`), BrainFeatureError, "entity_not_found");
    await rejectsWith(service().getEntity(OWNER, PROJECT, "person:email:alice@acme.dev"), BrainFeatureError, "entity_not_found");
  });

  it("erases scope rows on scope_erased and per-document rows through the core erase", async () => {
    await seedProject(harness);
    const other = { ...SCOPE, scopeId: "personal:project:proj_other" };
    const signal = new AbortController().signal;
    await harness.repository.eraseScope(SCOPE);
    expect([await count("brain_graph_state"), await count("brain_graph_links")]).toEqual([0, 0]);
    expect(await count("brain_graph_aliases")).toBe(1);
    await harness.graph.index.handle({ type: "scope_erased", scope: other, at: harness.iso() }, signal);
    expect(await harness.graph.index.refresh({ ownerId: OWNER, scopeId: "team:t1" }, {}, signal))
      .toEqual({ processed: 0, removed: 0, caughtUp: true });
    expect(await count("brain_graph_aliases")).toBe(1);
    await harness.graph.index.handle({ type: "scope_erased", scope: SCOPE, at: harness.iso() }, signal);
    expect(await Promise.all(GRAPH_TABLES.map(count))).toEqual([0, 0, 0, 0]);
  });

  it("sweeps entities nothing references and keeps the project entity", async () => {
    await seedProject(harness);
    expect(await service().getEntity(OWNER, PROJECT, `project:${PROJECT}`)).toMatchObject({ kind: "project" });
    await harness.sync("git", [], [id("commitB"), id("pr12"), id("spec")]);
    await harness.refresh();
    await rejectsWith(service().getEntity(OWNER, PROJECT, "folder:src"), BrainFeatureError, "entity_not_found");
    await rejectsWith(service().getEntity(OWNER, PROJECT, "spec:specs/001-alpha"), BrainFeatureError, "entity_not_found");
    expect((await service().getEntity(OWNER, PROJECT, "pull_request:12")).linkCount).toBe(2);
    expect(await service().getEntity(OWNER, PROJECT, `project:${PROJECT}`)).toMatchObject({ kind: "project" });
  });

  it("stops on abort, budget and entity capacity and skips documents erased mid-write", async () => {
    await harness.sync("git", [FIXTURE.pr12, FIXTURE.commitB, FIXTURE.spec]);
    const aborted = AbortSignal.abort();
    expect(await harness.graph.index.refresh(SCOPE, {}, aborted)).toEqual({ processed: 0, removed: 0, caughtUp: false });
    const ids = [id("pr12"), id("commitB")];
    await harness.graph.index.handle({ type: "documents_changed", scope: SCOPE, sourceId: null, documentIds: ids,
      at: harness.iso() }, aborted);
    expect(await count("brain_graph_state")).toBe(0);
    expect(await harness.graph.index.refresh(SCOPE, { documents: 1, budgetMs: Number.NaN }, new AbortController().signal))
      .toEqual({ processed: 1, removed: 0, caughtUp: false });
    const db = harness.db.withTables<BrainGraphTables>();
    const full = createBrainGraphIndex({ db, now: harness.now, maxEntities: 5 });
    // Only a full graph says it is stuck; an abort or a spent budget does not.
    expect(await full.refresh(SCOPE, {}, new AbortController().signal))
      .toEqual({ processed: 0, removed: 0, caughtUp: false, stopReason: "graph_capacity" });
  });

  it("cites footerless git documents and other provenances, and derives documents without links", async () => {
    const edge = (seed: string, provenance: string, body: string, at: string, extra: [string, string][] = []) => ({
      documentId: id(seed), title: `Edge ${seed}`, body, permalink: "", sourceUpdatedAt: at, provenance,
      refs: [["path", "edge.ts"], ...extra].map(([kind, value]) => ({ kind: kind!, value: value! })),
    });
    await harness.sync("git", [
      edge("plain", "git_pr", "Plain body", "2026-09-01T00:00:00.000Z"),
      edge("plainCommit", "git_commit", "Plain commit", "2026-09-02T00:00:00.000Z"),
      edge("nonumber", "git_pr", `Body\n\nCommit: ${"c".repeat(40)}\nChanged paths: 1`, "2026-09-03T00:00:00.000Z"),
      edge("noauthor", "git_commit", `Commit: ${"d".repeat(40)}\nChanged paths: 1`, "2026-09-04T00:00:00.000Z"),
      edge("manual", "manual", "Notes", "2026-09-05T00:00:00.000Z"),
      edge("specs", "git_spec", "Two specs", "2026-09-06T00:00:00.000Z", [["spec", "specs/009-b"], ["spec", "specs/008-a"]]),
      { ...edge("bare", "manual", "Nothing here", "2026-09-07T00:00:00.000Z"), refs: [] },
    ]);
    const graph = createBrainGraph({ repository: harness.repository, resolver });
    expect(await graph.service.refresh(OWNER, PROJECT)).toMatchObject({
      index: "graph", processed: 7, removed: 0, caughtUp: true, freshness: { caughtUp: true },
    });
    const items = (await timeline("file:edge.ts")).items.map((item) => [item.cite.kind, item.cite.label]);
    expect(items).toEqual([["spec", "specs/008-a"], ["document", "Edge manual"], ["commit", "d".repeat(12)],
      ["pr", "c".repeat(12)], ["commit", "commit"], ["pr", "PR"]]);
    expect(await count("brain_graph_links")).toBe(2);
  });
});
