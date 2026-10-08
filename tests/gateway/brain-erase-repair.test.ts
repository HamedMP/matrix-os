/**
 * The project erase over PGlite with the graph: a refresh already running when the project is erased writes nothing
 * back.
 */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eraseBrainScopeRows } from "../../packages/gateway/src/brain/api/erase.js";
import type { BrainGraphTables } from "../../packages/gateway/src/brain/graph/index.js";
import { createBrainGraphIndex } from "../../packages/gateway/src/brain/graph/refresh.js";
import { SCOPE, createGraphHarness, seedProject, type GraphHarness } from "./helpers/brain-graph-fixtures.js";

const GRAPH_TABLES = ["brain_graph_entities", "brain_graph_links", "brain_graph_state", "brain_graph_aliases"] as const;

describe("brain project erase", { timeout: 60_000 }, () => {
  let harness: GraphHarness;
  beforeEach(async () => { harness = await createGraphHarness(); });
  afterEach(() => harness.destroy());

  const rows = async (table: string) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n
    FROM ${sql.table(table)} WHERE owner_id = ${SCOPE.ownerId} AND scope_id = ${SCOPE.scopeId}`.execute(harness.db))
    .rows[0]!.n);

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
});
