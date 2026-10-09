/** Graph bounds and dependents over PGlite: one refresh cap, reads under the deadline, live links, stale inputs. */
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainApiError } from "../../packages/gateway/src/brain/api/types.js";
import { brainEntityId, createBrainGraph } from "../../packages/gateway/src/brain/graph/index.js";
import { BrainRepository, type BrainDatabase } from "../../packages/gateway/src/brain/index.js";
import {
  FIXTURE, OWNER, PROJECT, SCOPE, createGraphHarness, id, rejectsWith, resolver, seedProject, type GraphHarness,
} from "./helpers/brain-graph-fixtures.js";

describe("brain graph bounds", { timeout: 60_000 }, () => {
  let harness: GraphHarness;
  beforeEach(async () => { harness = await createGraphHarness(); });
  afterEach(() => harness.destroy());

  it("shares two refresh slots between the service, index refreshes and hooks, never holding an erase", async () => {
    let [held, hold, open] = [0, true, () => {}];
    const gate = new Promise<void>((resolve) => { open = resolve; });
    // While held, a refresh parks in its sweep's project name lookup, keeping its slot.
    const { service, index } = createBrainGraph({ repository: harness.repository, now: harness.now, resolver: {
      ...resolver, async resolve(ownerId, projectRef) {
        if (hold) { held += 1; await gate; }
        return resolver.resolve(ownerId, projectRef);
      },
    } });
    const signal = new AbortController().signal;
    const changed = { type: "documents_changed" as const, scope: SCOPE, sourceId: null, documentIds: null, at: "" };
    const running = [index.refresh(SCOPE, {}, signal), index.handle(changed, signal)];
    await vi.waitFor(() => expect(held).toBe(2));
    hold = false;
    await rejectsWith(index.refresh(SCOPE, {}, signal), BrainApiError, "brain_unavailable");
    const hook = index.handle({ ...changed, documentIds: [id("pr12")] }, signal);
    await rejectsWith(hook, BrainApiError, "brain_unavailable");
    await rejectsWith(service.refresh(OWNER, PROJECT), BrainApiError, "brain_unavailable");
    await index.handle({ type: "scope_erased", scope: SCOPE, at: harness.iso() }, signal);
    open();
    await Promise.all(running);
    expect(await service.refresh(OWNER, PROJECT)).toMatchObject({ index: "graph", caughtUp: true });
  });

  it("scans pending documents read only under the read deadline", async () => {
    const statements: string[] = [];
    const db = new Kysely<BrainDatabase>({ dialect: (await KyselyPGlite.create()).dialect, log: (event) => {
      if (event.level === "query") statements.push(event.query.sql);
    } });
    const repository = new BrainRepository(db, { now: harness.now });
    await repository.bootstrap();
    const logged = await createGraphHarness({ ...harness, repository, db, destroy: () => db.destroy() });
    try {
      await logged.sync("git", [FIXTURE.pr12, FIXTURE.commitB]);
      statements.length = 0;
      expect(await logged.refresh()).toMatchObject({ processed: 2, caughtUp: true });
      // Each pending scan runs in an open transaction that began read only, under the read statement deadline.
      const scans = statements.flatMap((statement, at) => statement.includes("LEFT JOIN brain_graph_state")
        ? [statements.slice(Math.max(0, statements.lastIndexOf("BEGIN", at)), at)] : []);
      expect(scans.length).toBeGreaterThan(1);
      const read = ["BEGIN", "SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '10000ms'"];
      for (const before of scans) expect(before).toEqual([...read, ...before.slice(3).filter((s) => s !== "COMMIT")]);
    } finally {
      await logged.destroy();
    }
  });

  it("pages a neighbourhood past the links of a tombstoned document a refresh has yet to remove", async () => {
    await seedProject(harness);
    // The issue assigned to Alice is her newest link; tombstoned, its stored links wait for a refresh.
    await harness.sync("linear", [], [id("issue")]);
    const alice = brainEntityId("person", "email:alice@acme.dev");
    const view = await harness.graph.service.links(OWNER, PROJECT, alice, { limit: 1 });
    expect(view.links.map((link) => link.evidence.cite.documentId)).toEqual([id("commitB")]);
  });

  it("drops a comment's part_of link once its parent, never derived, is tombstoned", async () => {
    await harness.sync("linear", [FIXTURE.issue, FIXTURE.comment]);
    // A hook derives only the comment, so the issue has no graph state when it is tombstoned.
    await harness.graph.index.handle({ type: "documents_changed", scope: SCOPE, sourceId: null,
      documentIds: [id("comment")], at: "" }, new AbortController().signal);
    const partOf = async () => (await sql<{ document_id: string }>`SELECT document_id FROM brain_graph_links
      WHERE ref_kind = 'parent'`.execute(harness.db)).rows.map((row) => row.document_id);
    expect(await partOf()).toEqual([id("comment")]);
    await harness.sync("linear", [], [id("issue")]);
    expect(await harness.refresh()).toMatchObject({ caughtUp: true });
    expect(await partOf()).toEqual([]);
  });
});
