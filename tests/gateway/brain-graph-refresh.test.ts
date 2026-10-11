/**
 * Graph refresh: what makes a derived document pending again, how refresh repairs it, and the entity limit. PGlite
 * always; the concurrent writers check on a disposable PostgreSQL schema when MATRIX_TEST_POSTGRES_URL is set.
 */
import { randomUUID } from "node:crypto";
import { PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainFeatureError } from "../../packages/gateway/src/brain/contracts.js";
import type { BrainGraphTables } from "../../packages/gateway/src/brain/graph/index.js";
import { createBrainGraphIndex } from "../../packages/gateway/src/brain/graph/refresh.js";
import { BrainRepository } from "../../packages/gateway/src/brain/index.js";
import {
  FIXTURE, OWNER, PROJECT, SCOPE, SPEC_DECISION, createGraphHarness, gitBody, id, rejectsWith, type GraphHarness,
} from "./helpers/brain-graph-fixtures.js";
import { BRAIN_CLOCK_START, brainDocumentId, type BrainHarness } from "./helpers/brain-store-helpers.js";

const entityCount = async (h: GraphHarness) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n
  FROM brain_graph_entities WHERE owner_id = ${SCOPE.ownerId} AND scope_id = ${SCOPE.scopeId}`.execute(h.db))
  .rows[0]!.n);
/** An index whose scope holds at most `maxEntities` entities. */
const capped = (h: GraphHarness, maxEntities: number) =>
  createBrainGraphIndex({ db: h.db.withTables<BrainGraphTables>(), now: h.now, maxEntities });
const changed = (h: GraphHarness, ...documentIds: string[]) =>
  ({ type: "documents_changed" as const, scope: SCOPE, sourceId: null, documentIds, at: h.iso() });

/** pr12 derived, then commitB and the issue synced but not derived: each would add two entities. */
async function seedNearLimit(h: GraphHarness): Promise<number> {
  await h.sync("git", [FIXTURE.pr12]);
  await h.refresh();
  // commitB adds its document and name:alice smith, the issue its document and issue:ENG-42.
  await h.sync("git", [FIXTURE.commitB]);
  await h.sync("linear", [FIXTURE.issue]);
  return entityCount(h);
}

describe("brain graph refresh", { timeout: 60_000 }, () => {
  let harness: GraphHarness;
  beforeEach(async () => { harness = await createGraphHarness(); });
  afterEach(() => harness.destroy());

  const timeline = (entity: string, query: Record<string, unknown> = {}) =>
    harness.graph.service.timeline(OWNER, PROJECT, { entity, ...query });
  const documents = async (entity: string, query: Record<string, unknown> = {}) =>
    (await timeline(entity, query)).items.map((item) => item.cite.documentId);

  it("re-derives a document whose refs changed while its revision stayed", async () => {
    await harness.sync("linear", [FIXTURE.issue]);
    await harness.refresh();
    expect(await documents("person:email:alice@acme.dev")).toEqual([id("issue")]);
    // Same title, body and permalink: the core keeps the revision and only replaces the refs. No hook runs.
    const refs = FIXTURE.issue.refs!
      .map((ref) => ref.kind === "assignee" ? { ...ref, value: "email:erin@acme.dev" } : ref);
    await harness.sync("linear", [{ ...FIXTURE.issue, refs }]);
    expect((await harness.repository.getDocument(SCOPE, id("issue")))!.revision).toBe(1);
    expect((await harness.graph.index.freshness(SCOPE)).pendingDocuments).toBe(1);
    expect(await harness.refresh()).toMatchObject({ processed: 1, caughtUp: true });
    expect(await documents("person:email:erin@acme.dev")).toEqual([id("issue")]);
    await rejectsWith(timeline("person:email:alice@acme.dev"), BrainFeatureError, "entity_not_found");
  });

  it("re-derives a decision when a path it quotes gains or loses its path ref", async () => {
    await harness.sync("git", [FIXTURE.spec]);
    await harness.decide(id("spec"), SPEC_DECISION);
    await harness.refresh();
    // src/alpha.ts is no path ref yet, so the decision names no file.
    await rejectsWith(timeline("file:src/alpha.ts"), BrainFeatureError, "entity_not_found");
    await harness.sync("git", [FIXTURE.commitB]);
    expect(await harness.refresh()).toMatchObject({ processed: 2, caughtUp: true });
    expect(await documents("file:src/alpha.ts", { linkTypes: ["decided_in"] })).toEqual([id("spec")]);
    await harness.sync("git", [], [id("commitB")]);
    expect(await harness.refresh()).toEqual({ processed: 1, removed: 1, caughtUp: true });
    await rejectsWith(timeline("file:src/alpha.ts"), BrainFeatureError, "entity_not_found");
  });

  it("widens a document entity's seen range when a revision moves its source time", async () => {
    await harness.sync("linear", [FIXTURE.issue]);
    await harness.refresh();
    await harness.sync("linear", [{ ...FIXTURE.issue, body: "Track alpha, now later.", sourceUpdatedAt:
      "2026-09-20T10:00:00.000Z" }]);
    expect(await harness.refresh()).toMatchObject({ processed: 1, caughtUp: true });
    expect(await harness.graph.service.getEntity(OWNER, PROJECT, `document:${id("issue")}`)).toMatchObject({
      firstSeenAt: "2026-09-06T10:00:00.000Z", lastSeenAt: "2026-09-20T10:00:00.000Z",
    });
  });

  it("re-derives a document when a sync moves only its source time, so link and entity dates follow", async () => {
    await harness.sync("linear", [FIXTURE.issue]);
    await harness.refresh();
    const later = "2026-09-20T10:00:00.000Z";
    await harness.sync("linear", [{ ...FIXTURE.issue, sourceUpdatedAt: later }]);
    expect(await harness.repository.getDocument(SCOPE, id("issue"))).toMatchObject({ revision: 1, sourceUpdatedAt: later });
    expect(await harness.refresh()).toMatchObject({ processed: 1, caughtUp: true });
    const links = await sql<{ at: Date }>`SELECT DISTINCT at FROM brain_graph_links WHERE document_id = ${id("issue")}`
      .execute(harness.db);
    expect(links.rows.map((row) => new Date(row.at).toISOString())).toEqual([later]);
    expect(await harness.graph.service.getEntity(OWNER, PROJECT, "issue:ENG-42")).toMatchObject({ lastSeenAt: later });
  });

  it("re-derives every child of a removed parent, past one hundred", async () => {
    const comments = Array.from({ length: 101 }, (_, index) => ({
      ...FIXTURE.comment, documentId: brainDocumentId(`comment-${index}`), title: `Comment ${index}`,
    }));
    await harness.sync("linear", [FIXTURE.issue, ...comments]);
    await harness.refresh();
    expect((await harness.graph.service.getEntity(OWNER, PROJECT, "issue:ENG-42")).linkCount).toBe(102);
    await harness.sync("linear", [], [id("issue")]);
    expect(await harness.refresh()).toEqual({ processed: 101, removed: 1, caughtUp: true });
    // No comment keeps a part_of link to the removed issue, so its entity was swept.
    await rejectsWith(harness.graph.service.getEntity(OWNER, PROJECT, "issue:ENG-42"), BrainFeatureError,
      "entity_not_found");
  });

  it("never passes the entity limit, counting the document entity", async () => {
    const base = await seedNearLimit(harness);
    const full = capped(harness, base + 3);
    const signal = new AbortController().signal;
    await full.handle(changed(harness, id("commitB")), signal);
    await full.handle(changed(harness, id("issue")), signal);
    expect(await entityCount(harness)).toBe(base + 2);
    expect(await full.refresh(SCOPE, {}, signal))
      .toEqual({ processed: 0, removed: 0, caughtUp: false, stopReason: "graph_capacity" });
    expect(await entityCount(harness)).toBe(base + 2);
  });

  it("re-derives at the limit when nothing is added and sweeps to make room before stopping", async () => {
    await harness.sync("git", [FIXTURE.pr12]);
    await harness.refresh();
    const max = await entityCount(harness);
    const full = capped(harness, max);
    const signal = new AbortController().signal;
    // Dropping the spec refs adds nothing, so it derives at the limit; four spec entities are left unreferenced.
    const refs = FIXTURE.pr12.refs!.filter((ref) => !ref.value.startsWith("specs/"));
    await harness.sync("git", [{ ...FIXTURE.pr12, refs }]);
    await full.handle(changed(harness, id("pr12")), signal);
    expect((await full.freshness(SCOPE)).caughtUp).toBe(true);
    // commitB needs two new entities: the sweep makes the room.
    await harness.sync("git", [FIXTURE.commitB]);
    expect(await full.refresh(SCOPE, {}, signal)).toEqual({ processed: 1, removed: 0, caughtUp: true });
    expect(await entityCount(harness)).toBe(max - 2);
    expect(await documents(`document:${id("commitB")}`)).toEqual([id("commitB")]);
  });

  it("goes past a document refused at the limit, so one that adds nothing can make the room", async () => {
    const holder = (assignees: readonly string[]) => ({
      documentId: brainDocumentId("holder"), title: "Holder", body: "Owners.", permalink: "", provenance: "manual",
      sourceUpdatedAt: "2026-09-01T10:00:00.000Z", refs: assignees.map((value) => ({ kind: "assignee", value })),
    });
    await harness.sync("git", [holder(["github:xavier", "github:yusuf"])]);
    await harness.refresh();
    const max = await entityCount(harness);
    const full = capped(harness, max);
    // Both pending, no hook: the newcomer (first by id) needs two entities; the holder drops both people, adding none.
    const newcomer = {
      documentId: brainDocumentId("late-1"), title: "chore: newcomer", permalink: "", provenance: "git_commit",
      sourceUpdatedAt: "2026-09-08T10:00:00.000Z", refs: [],
      body: gitBody("chore: newcomer", { sha: "c".repeat(40), author: "Zed Quinn" }),
    };
    expect(newcomer.documentId < brainDocumentId("holder")).toBe(true);
    await harness.sync("git", [holder([]), newcomer]);
    expect(await full.refresh(SCOPE, {}, new AbortController().signal))
      .toEqual({ processed: 2, removed: 0, caughtUp: true });
    expect(await entityCount(harness)).toBe(max);
    expect(await documents("person:name:zed quinn")).toEqual([newcomer.documentId]);
  });
});

// PGlite runs every transaction on one session, so only PostgreSQL shows writers waiting on the graph lock.
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;

/**
 * A graph harness on a fresh schema: destroy closes the store, drops the schema and ends the admin pool. A failed
 * setup does the same before it rethrows, so no connection stays open.
 */
async function openPostgresGraph(
  build: (base: BrainHarness) => Promise<GraphHarness> = createGraphHarness,
): Promise<GraphHarness> {
  const schema = `brain_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  url.searchParams.set("application_name", schema);
  let clock = new Date(BRAIN_CLOCK_START);
  const repository = new BrainRepository(new PostgresDialect({
    pool: new pg.Pool({ connectionString: url.toString(), max: 4 }) }), { now: () => clock });
  const destroy = async () => {
    try {
      await repository.destroy();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).finally(() => admin.end());
    }
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await repository.bootstrap();
    return await build({
      repository, db: repository.kysely, now: () => clock, iso: () => clock.toISOString(),
      tick(ms = 1_000) { clock = new Date(clock.getTime() + ms); }, destroy,
    });
  } catch (error) {
    await destroy();
    throw error;
  }
}

describe.skipIf(!databaseUrl)("brain graph refresh on PostgreSQL", { timeout: 120_000 }, () => {
  let harness: GraphHarness;
  beforeEach(async () => {
    const opened = await openPostgresGraph();
    harness = opened;
    return () => opened.destroy();
  });

  it("checks the entity limit under the graph lock when writers run at once", async () => {
    const base = await seedNearLimit(harness);
    const signal = new AbortController().signal;
    // Two writers, each with its own index: the second to take the lock sees the first one's entities.
    await Promise.all([
      capped(harness, base + 3).handle(changed(harness, id("commitB")), signal),
      capped(harness, base + 3).handle(changed(harness, id("issue")), signal),
    ]);
    expect(await entityCount(harness)).toBe(base + 2);
    expect((await harness.graph.index.freshness(SCOPE)).pendingDocuments).toBe(1);
  });

  it("closes its connections and drops its schema when setup fails", async () => {
    let schema = "";
    const failing = async (base: BrainHarness): Promise<GraphHarness> => {
      schema = (await sql<{ s: string }>`SELECT current_schema() AS s`.execute(base.db)).rows[0]!.s;
      throw new Error("setup failed");
    };
    await expect(openPostgresGraph(failing)).rejects.toThrow("setup failed");
    expect(schema).toMatch(/^brain_/);
    const probe = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await vi.waitFor(async () => expect((await probe.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", [schema])).rows[0].n).toBe(0));
      expect((await probe.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1", [schema]))
        .rows[0].n).toBe(0);
    } finally {
      await probe.end();
    }
  });
});
