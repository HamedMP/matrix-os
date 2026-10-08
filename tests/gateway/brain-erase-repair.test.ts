/**
 * The project erase and the removed source purge over PGlite with the graph: a refresh already running when the
 * project is erased writes nothing back, and a purge drops the derived rows of every tombstoned document of the
 * removed source, whenever it was tombstoned, and leaves no person only that source named readable.
 */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eraseBrainScopeRows } from "../../packages/gateway/src/brain/api/erase.js";
import { purgeBrainRemovedSource } from "../../packages/gateway/src/brain/api/index-repair.js";
import { BrainFeatureError } from "../../packages/gateway/src/brain/contracts.js";
import type { BrainGraphTables } from "../../packages/gateway/src/brain/graph/index.js";
import { createBrainGraphIndex } from "../../packages/gateway/src/brain/graph/refresh.js";
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
});
