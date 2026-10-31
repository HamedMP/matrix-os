/**
 * Graph reads over PGlite: merged people at the alias cap and across automatic merges, two-hop neighbourhoods, entity
 * paging, merge suggestions over live documents and past the split cap, read deadlines.
 */
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAIN_GRAPH_LIMITS } from "../../packages/gateway/src/brain/contracts.js";
import { brainEntityId } from "../../packages/gateway/src/brain/graph/ids.js";
import type { BrainGraphTables } from "../../packages/gateway/src/brain/graph/index.js";
import { listMergeSuggestions } from "../../packages/gateway/src/brain/graph/merge-suggestions.js";
import { BrainRepository, type BrainDatabase } from "../../packages/gateway/src/brain/index.js";
import {
  FIXTURE, OWNER, PROJECT, SCOPE, createGraphHarness, gitBody, id, seedProject, type GraphHarness,
} from "./helpers/brain-graph-fixtures.js";
import { BRAIN_CLOCK_START, brainDocumentId } from "./helpers/brain-store-helpers.js";

/** A git commit document authored by `author` with `trailers` as its message's trailer lines. */
function commit(seed: string, author: string, trailers: readonly string[], at: string) {
  return {
    documentId: brainDocumentId(seed), title: `chore: ${seed}`, permalink: "", sourceUpdatedAt: at,
    provenance: "git_commit", refs: [],
    body: gitBody(`chore: ${seed}\n\n${trailers.join("\n")}`, { sha: brainDocumentId(seed).slice(0, 40), author }),
  };
}

/** A Linear issue assigned to `assignee` (a person key). */
function issue(seed: string, assignee: string, at: string) {
  return {
    documentId: brainDocumentId(seed), title: `Issue ${seed}`, body: "Track it.", permalink: "", sourceUpdatedAt: at,
    provenance: "linear_issue", refs: [{ kind: "assignee", value: assignee }],
  };
}

/**
 * Statements that ran outside a transaction, or in one that set no statement deadline (`SET LOCAL statement_timeout`)
 * before them: reads that could hold a pool connection past the read deadline.
 */
function undeadlined(statements: readonly string[]): string[] {
  const out: string[] = [];
  let [open, bounded] = [false, false];
  for (const statement of statements) {
    if (statement === "BEGIN") [open, bounded] = [true, false];
    else if (statement === "COMMIT" || statement === "ROLLBACK") open = false;
    else if (open && statement.startsWith("SET LOCAL statement_timeout")) bounded = true;
    else if (!open || (!bounded && !statement.startsWith("SET "))) out.push(statement);
  }
  return out;
}

describe("brain graph reads", { timeout: 60_000 }, () => {
  let harness: GraphHarness;
  beforeEach(async () => { harness = await createGraphHarness(); });
  afterEach(() => harness.destroy());

  const service = () => harness.graph.service;

  it("keeps automatic name merges within the alias cap, leaving the rest their own people", async () => {
    const trailer = (index: number) => `Co-authored-by: Person ${index} <shared@acme.dev>`;
    const names = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => trailer(from + index));
    // 52 names seen with one email, the first 26 derived first.
    await harness.sync("git", [commit("crowd-a", "Person 0", names(0, 26), "2026-09-01T10:00:00.000Z")]);
    await harness.refresh();
    await harness.sync("git", [commit("crowd-b", "Person 51", names(26, 52), "2026-09-02T10:00:00.000Z")]);
    await harness.refresh();
    const merged = await sql<{ n: number }>`SELECT count(*)::int AS n FROM brain_graph_aliases
      WHERE owner_id = ${SCOPE.ownerId} AND scope_id = ${SCOPE.scopeId} AND state = 'merged'
        AND entity_id = ${brainEntityId("person", "email:shared@acme.dev")}`.execute(harness.db);
    expect(merged.rows[0]!.n).toBe(BRAIN_GRAPH_LIMITS.aliasesPerEntity);
    expect((await service().getEntity(OWNER, PROJECT, "person:name:person 0")).key).toBe("email:shared@acme.dev");
    // Past the cap the name is not merged, so its own links stay readable under it.
    const own = await service().timeline(OWNER, PROJECT, { entity: "person:name:person 51" });
    expect([own.entity.key, own.items.map((item) => item.cite.documentId)])
      .toEqual(["name:person 51", [brainDocumentId("crowd-b")]]);
  });

  it("carries a name's manual aliases into the email it merges into, and back when the merge goes", async () => {
    await harness.sync("git", [commit("bob-1", "Bob Jones", [], "2026-09-01T10:00:00.000Z")]);
    await harness.sync("linear", [issue("bobby-1", "github:bobby", "2026-09-02T10:00:00.000Z")]);
    await harness.refresh();
    await service().updateAlias(OWNER, PROJECT, "person:name:bob jones",
      { action: "merge", aliasKey: "person:github:bobby" });
    // A later trailer pairs the name with one email: the name merges into it, and github:bobby comes along.
    const paired = commit("bob-2", "Bob Jones", ["Co-authored-by: Bob Jones <bob@acme.dev>"],
      "2026-09-03T10:00:00.000Z");
    await harness.sync("git", [paired]);
    await harness.refresh();
    expect((await service().getEntity(OWNER, PROJECT, "person:github:bobby")).key).toBe("email:bob@acme.dev");
    const timeline = await service().timeline(OWNER, PROJECT, { entity: "person:email:bob@acme.dev" });
    expect(timeline.items.map((item) => item.cite.documentId))
      .toEqual([paired.documentId, brainDocumentId("bobby-1"), brainDocumentId("bob-1")]);
    // The pairing goes, so the automatic merge goes and github:bobby is back in the name.
    await harness.sync("git", [], [paired.documentId]);
    await harness.refresh();
    expect((await service().getEntity(OWNER, PROJECT, "person:github:bobby")).key).toBe("name:bob jones");
  });

  it("suggests and counts only from live documents, before a refresh too", async () => {
    await harness.sync("git", [commit("dana-1", "Dana Lee", [], "2026-09-01T10:00:00.000Z"),
      commit("dana-2", "Dana Lee", [], "2026-09-02T10:00:00.000Z")]);
    await harness.sync("linear", [issue("dana-3", "github:dana-lee", "2026-09-03T10:00:00.000Z")]);
    await harness.refresh();
    const suggested = async () => (await service().mergeSuggestions(OWNER, PROJECT, {})).items
      .map((item) => [item.entity.key, item.alias.key, item.counts.entityLinks, item.counts.aliasLinks]);
    expect(await suggested()).toEqual([["github:dana-lee", "name:dana lee", 1, 2]]);
    await harness.sync("git", [], [brainDocumentId("dana-2")]);
    expect(await suggested()).toEqual([["github:dana-lee", "name:dana lee", 1, 1]]);
    expect((await service().getEntity(OWNER, PROJECT, "person:name:dana lee")).linkCount).toBe(1);
    // github:dana-lee's only document is deleted: no suggestion names it, as the entity list does not.
    await harness.sync("linear", [], [brainDocumentId("dana-3")]);
    expect(await suggested()).toEqual([]);
  });

  it("never suggests a split pair again when the split scan is capped", async () => {
    await harness.sync("git", [commit("dana-1", "Dana Lee", [], "2026-09-01T10:00:00.000Z")]);
    await harness.sync("linear", [issue("dana-3", "github:dana-lee", "2026-09-03T10:00:00.000Z")]);
    await harness.refresh();
    const github = "person:github:dana-lee";
    await service().updateAlias(OWNER, PROJECT, github, { action: "merge", aliasKey: "person:name:dana lee" });
    await service().updateAlias(OWNER, PROJECT, github, { action: "split", aliasKey: "person:name:dana lee" });
    const db = harness.repository.kysely.withTables<BrainGraphTables>();
    const limits = { personsScanned: 100, splitsScanned: 100, pairsScanned: 100, suggestionsMax: 100 };
    expect(await listMergeSuggestions(db, SCOPE, { limit: 50 }, limits))
      .toEqual({ items: [], nextCursor: null, truncated: false });
    expect(await listMergeSuggestions(db, SCOPE, { limit: 50 }, { ...limits, splitsScanned: 0 }))
      .toEqual({ items: [], nextCursor: null, truncated: true });
  });

  it("pages entity search past exact matches without listing any entity twice", async () => {
    const note = (seed: string, path: string, at: string) => ({
      documentId: brainDocumentId(seed), title: `Doc ${seed}`, body: "Notes.", permalink: "", sourceUpdatedAt: at,
      provenance: "manual", refs: [{ kind: "path", value: path }],
    });
    // Two files named notes.md (exact matches for "notes") and one that only starts with it.
    await harness.sync("git", [note("n1", "docs/notes.md", "2026-09-01T10:00:00.000Z"),
      note("n2", "src/notes.md", "2026-09-02T10:00:00.000Z"),
      note("n3", "lib/notes-old.md", "2026-09-03T10:00:00.000Z")]);
    await harness.refresh();
    const keys = async (query: Record<string, unknown>) => {
      const view = await service().listEntities(OWNER, PROJECT, { q: "notes", ...query });
      return { keys: view.items.map((item) => item.key), next: view.nextCursor };
    };
    const all = (await keys({ limit: 50 })).keys;
    expect(all).toEqual(["src/notes.md", "docs/notes.md", "lib/notes-old.md"]);
    for (const limit of [1, 2]) {
      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let pages = 0; pages < 5 && cursor !== null; pages += 1) {
        const page = await keys({ limit, ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...page.keys);
        cursor = page.next;
      }
      expect([limit, seen, cursor]).toEqual([limit, all, null]);
    }
  });

  it("reads a merged neighbour's second hop through its entity and every key merged into it", async () => {
    // name:alice smith merges into email:alice@acme.dev; the solo commit names only the name key.
    const solo = commit("solo", "Alice Smith", [], "2026-09-08T10:00:00.000Z");
    await harness.sync("git", [FIXTURE.pr12, FIXTURE.commitB, solo]);
    await harness.refresh();
    const view = await service().links(OWNER, PROJECT, `document:${solo.documentId}`, { hops: 2 });
    const alice = brainEntityId("person", "email:alice@acme.dev");
    expect(view.nodes.map((node) => node.entityId)).toContain(alice);
    // pr12 names Alice by email only: reached only through the entity the name is merged into.
    const authored = new Set(view.links.filter((link) => link.type === "authored" && link.from.entityId === alice)
      .map((link) => link.to.key));
    expect([...authored].sort()).toEqual([id("commitB"), id("pr12"), solo.documentId].sort());
  });

  it("runs the timeline freshness scan and the alias answer under the read deadline", async () => {
    const statements: string[] = [];
    const db = new Kysely<BrainDatabase>({ dialect: (await KyselyPGlite.create()).dialect, log: (event) => {
      if (event.level === "query") statements.push(event.query.sql);
    } });
    let clock = new Date(BRAIN_CLOCK_START);
    const repository = new BrainRepository(db, { now: () => clock });
    await repository.bootstrap();
    const logged = await createGraphHarness({
      repository, db, now: () => clock, iso: () => clock.toISOString(),
      tick(ms = 1_000) { clock = new Date(clock.getTime() + ms); }, destroy: () => db.destroy(),
    });
    try {
      await seedProject(logged);
      statements.length = 0;
      await logged.graph.service.timeline(OWNER, PROJECT, { entity: "pull_request:12" });
      expect(statements.some((statement) => statement.includes("LEFT JOIN brain_graph_state"))).toBe(true);
      expect(undeadlined(statements)).toEqual([]);
      statements.length = 0;
      await logged.graph.service.updateAlias(OWNER, PROJECT, brainEntityId("person", "email:alice@acme.dev"),
        { action: "merge", aliasKey: "person:github:alice" });
      expect(statements.some((statement) => statement.startsWith("insert into \"brain_graph_aliases\""))).toBe(true);
      expect(undeadlined(statements)).toEqual([]);
    } finally {
      await logged.destroy();
    }
  });
});
