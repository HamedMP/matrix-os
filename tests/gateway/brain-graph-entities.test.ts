/** Graph entities, person aliases, neighbourhoods and dependent re-derivation over PGlite. */
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainApiError } from "../../packages/gateway/src/brain/api/types.js";
import { BrainFeatureError, type BrainNeighbourhoodView } from "../../packages/gateway/src/brain/contracts.js";
import { brainEntityId, type BrainGraphTables } from "../../packages/gateway/src/brain/graph/index.js";
import { createBrainGraphIndex } from "../../packages/gateway/src/brain/graph/refresh.js";
import { graphTimeline } from "../../packages/gateway/src/brain/graph/timeline.js";
import {
  FIXTURE, OWNER, PROJECT, SCOPE, createGraphHarness, gitBody, id, rejectsWith, seedProject, type GraphHarness,
} from "./helpers/brain-graph-fixtures.js";
import { dropCites } from "./helpers/brain-cite-fakes.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";

const linkSummary = (view: BrainNeighbourhoodView) =>
  view.links.map((link) => `${link.from.key}-${link.type}->${link.to.key}`).sort();

/** Throws `error` for every insert into brain_graph_links. */
function failingLinks(error: unknown): KyselyPlugin {
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      const node = args.node as { kind: string; into?: { table: { identifier: { name: string } } } };
      if (node.kind === "InsertQueryNode" && node.into?.table.identifier.name === "brain_graph_links") throw error;
      return args.node;
    },
    transformResult: async (args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> => args.result,
  };
}

describe("brain graph entities, aliases and links", { timeout: 60_000 }, () => {
  let harness: GraphHarness;
  beforeEach(async () => { harness = await createGraphHarness(); });
  afterEach(() => harness.destroy());

  const service = () => harness.graph.service;
  const people = async (query = {}) =>
    (await service().listEntities(OWNER, PROJECT, { kind: "person", ...query })).items.map((item) => item.key);
  const alias = (entity: string, action: "merge" | "split" | "unmerge", aliasKey: string) =>
    service().updateAlias(OWNER, PROJECT, brainEntityId("person", entity), { action, aliasKey });
  const personTimeline = async (key: string) =>
    (await service().timeline(OWNER, PROJECT, { entity: `person:${key}` })).items.map((item) => item.cite.documentId);

  it("lists entities newest first without merged aliases, with prefix search and paging", async () => {
    await seedProject(harness);
    expect(await people()).toEqual([
      "email:dana@acme.dev", "email:alice@acme.dev", "github:carol", "github:alice", "name:bob jones",
    ]);
    expect(await people({ q: "ALI" })).toEqual(["email:alice@acme.dev", "github:alice"]);
    const first = await service().listEntities(OWNER, PROJECT, { kind: "person", limit: 3 });
    const next = await service().listEntities(OWNER, PROJECT, { kind: "person", limit: 3, cursor: first.nextCursor! });
    expect([...first.items, ...next.items].map((item) => item.key)).toEqual(await people());
    expect(next.nextCursor).toBeNull();
    await rejectsWith(service().listEntities(OWNER, PROJECT, { cursor: first.nextCursor! }), BrainApiError,
      "invalid_request");
    const all = await service().listEntities(OWNER, PROJECT, { limit: 50 });
    expect(new Set(all.items.map((item) => item.kind))).toEqual(new Set([
      "document", "person", "pull_request", "issue", "spec", "file", "folder", "project",
    ]));
    await rejectsWith(service().listEntities(OWNER, PROJECT, { kind: "team" as never }), BrainApiError,
      "invalid_request");
    const keys = async (query: object) =>
      (await service().listEntities(OWNER, PROJECT, query)).items.map((item) => `${item.kind}:${item.key}`);
    expect((await keys({ q: "alpha", limit: 2 }))).toEqual(["file:src/alpha.ts", `document:${id("spec")}`]);
    expect(await keys({ kind: "spec", q: "001" })).toEqual(["spec:specs/001-alpha"]);
    const firstExact = await service().listEntities(OWNER, PROJECT, { q: "alpha", limit: 1 });
    const after = await service().listEntities(OWNER, PROJECT, { q: "alpha", limit: 50, cursor: firstExact.nextCursor! });
    expect(after.items.map((item) => item.key)).toContain(id("spec"));
  });

  it("counts a file's changes as links and reads folder refs with a trailing slash", async () => {
    await seedProject(harness);
    expect(await service().getEntity(OWNER, PROJECT, "file:src/alpha.ts")).toMatchObject({ linkCount: 3 });
    expect((await service().getEntity(OWNER, PROJECT, "folder:src/")).linkCount).toBeGreaterThanOrEqual(2);
    expect((await service().timeline(OWNER, PROJECT, { entity: "folder:src/" })).items).toHaveLength(2);
  });

  it("leaves out a timeline document whose cite went away between the page and the cite read", async () => {
    await seedProject(harness);
    const query = { entity: "folder:src/", from: null, to: null, limit: 10 };
    const fresh = { caughtUp: true, pendingDocuments: 0, pendingCapped: false };
    const db = harness.db.withTables<BrainGraphTables>();
    expect((await graphTimeline(db, SCOPE, query, fresh)).items).toHaveLength(2);
    expect((await graphTimeline(db.withPlugin(dropCites()), SCOPE, query, fresh)).items).toEqual([]);
  });

  it("shows an entity with its aliases and link count, through an alias or a ref", async () => {
    await seedProject(harness);
    const view = await service().getEntity(OWNER, PROJECT, "person:name:alice smith");
    expect(view).toMatchObject({
      entityId: brainEntityId("person", "email:alice@acme.dev"), kind: "person", displayName: "Alice Smith",
      aliases: [{ aliasKey: "person:name:alice smith", reason: "single_email_for_name", state: "merged" }],
      firstSeenAt: "2026-09-01T10:00:00.000Z", lastSeenAt: "2026-09-06T10:00:00.000Z", linkCount: 4,
      linkCountCapped: false,
    });
    expect((await service().getEntity(OWNER, PROJECT, brainEntityId("pull_request", "12"))).displayName).toBe("#12");
    await rejectsWith(service().getEntity(OWNER, PROJECT, "x".repeat(601)), BrainApiError, "invalid_request");
  });

  it("merges and splits person aliases by hand and never re-merges a split key", async () => {
    await seedProject(harness);
    const alice = "email:alice@acme.dev";
    expect(await personTimeline(alice)).toEqual([id("issue"), id("commitB"), id("pr12")]);
    harness.tick();
    const merged = await alias(alice, "merge", "person:github:alice");
    expect(merged.aliases.map((row) => [row.aliasKey, row.reason, row.state])).toEqual([
      ["person:name:alice smith", "single_email_for_name", "merged"], ["person:github:alice", "manual", "merged"],
    ]);
    expect(await personTimeline(alice)).toEqual([id("issue"), id("githubPr"), id("commitB"), id("pr12")]);
    expect((await alias(alice, "merge", "person:github:alice")).aliases).toHaveLength(2);
    await rejectsWith(alias("github:carol", "merge", "person:github:alice"), BrainFeatureError, "alias_conflict");
    await rejectsWith(alias("github:carol", "split", "person:github:alice"), BrainFeatureError, "alias_conflict");
    await rejectsWith(alias(alice, "merge", "person:github:nobody"), BrainFeatureError, "entity_not_found");
    await rejectsWith(alias(alice, "merge", "pull_request:12"), BrainApiError, "invalid_request");
    await rejectsWith(alias(alice, "merge", `person:${alice}`), BrainApiError, "invalid_request");
    await rejectsWith(service().updateAlias(OWNER, PROJECT, brainEntityId("pull_request", "12"),
      { action: "merge", aliasKey: "person:github:alice" }), BrainApiError, "invalid_request");
    await rejectsWith(service().updateAlias(OWNER, PROJECT, "pull_request:12", { action: "join" as never, aliasKey: "x" }),
      BrainApiError, "invalid_request");
    // Merging Alice into Carol carries Alice's aliases along; splitting her out sends the name alias back to her.
    await alias("github:carol", "merge", `person:${alice}`);
    await harness.sync("git", [{ ...FIXTURE.pr12, title: "feat: alpha v1" }]);
    await harness.refresh();
    expect((await service().getEntity(OWNER, PROJECT, "person:name:alice smith")).key).toBe("github:carol");
    await alias("email:dana@acme.dev", "merge", "person:github:carol");
    expect((await service().getEntity(OWNER, PROJECT, "person:github:alice")).key).toBe("email:dana@acme.dev");
    await alias("email:dana@acme.dev", "split", "person:github:carol");
    const carol = await alias("github:carol", "split", `person:${alice}`);
    expect(carol.aliases.map((row) => [row.aliasKey, row.state])).toEqual([[`person:${alice}`, "split"]]);
    expect((await service().getEntity(OWNER, PROJECT, "person:name:alice smith")).key).toBe(alice);
    expect((await service().getEntity(OWNER, PROJECT, "person:github:alice")).key).toBe(alice);
    // A split automatic alias stays split when its document is derived again.
    await alias(alice, "split", "person:name:alice smith");
    await harness.sync("git", [{ ...FIXTURE.pr12, title: "feat: alpha v2" }]);
    await harness.refresh();
    expect((await service().getEntity(OWNER, PROJECT, "person:name:alice smith")).key).toBe("name:alice smith");
    expect(await personTimeline("name:alice smith")).toEqual([id("commitB")]);
  });

  it("undoes a manual merge with unmerge, giving back the state before it, carried aliases and derivation included", async () => {
    await seedProject(harness);
    const alice = "email:alice@acme.dev";
    const before = (await service().getEntity(OWNER, PROJECT, `person:${alice}`)).aliases;
    // Carol takes Alice, and Alice's automatic name alias rides along.
    await alias("github:carol", "merge", `person:${alice}`);
    expect((await service().getEntity(OWNER, PROJECT, "person:name:alice smith")).key).toBe("github:carol");
    await rejectsWith(alias("github:carol", "unmerge", "person:name:alice smith"), BrainFeatureError, "alias_conflict");
    const carol = await alias("github:carol", "unmerge", `person:${alice}`);
    expect(carol.aliases).toEqual([]);
    expect((await service().getEntity(OWNER, PROJECT, "person:name:alice smith")).key).toBe(alice);
    expect((await service().getEntity(OWNER, PROJECT, `person:${alice}`)).aliases).toEqual(before);
    await rejectsWith(alias("github:carol", "unmerge", `person:${alice}`), BrainFeatureError, "alias_conflict");
    // Unmerging a manual merge of a name key hands that name back to derivation, which merges it again by email.
    await harness.db.withTables<BrainGraphTables>().deleteFrom("brain_graph_aliases")
      .where("alias_key", "=", "person:name:alice smith").execute();
    await alias("github:carol", "merge", "person:name:alice smith");
    expect((await service().getEntity(OWNER, PROJECT, "person:name:alice smith")).key).toBe("github:carol");
    await alias("github:carol", "unmerge", "person:name:alice smith");
    expect((await service().getEntity(OWNER, PROJECT, "person:name:alice smith")).key).toBe(alice);
    // A split is never undone by unmerge.
    await alias(alice, "split", "person:name:alice smith");
    await rejectsWith(alias(alice, "unmerge", "person:name:alice smith"), BrainFeatureError, "alias_conflict");
  });

  it("caps the aliases of one entity", async () => {
    const participants = Array.from({ length: 51 }, (_, index) => ({ kind: "participant", value: `email:p${index}@x.dev` }));
    await harness.sync("linear", [{ ...FIXTURE.issue, refs: [...FIXTURE.issue.refs!, ...participants] }]);
    await harness.refresh();
    for (let index = 1; index <= 50; index += 1) await alias("email:p0@x.dev", "merge", `person:email:p${index}@x.dev`);
    await rejectsWith(alias("email:p0@x.dev", "merge", "person:email:alice@acme.dev"), BrainApiError, "brain_capacity");
  });

  it("answers one- and two-hop neighbourhoods with direction, type filters and paging", async () => {
    await seedProject(harness);
    const links = (entity: string, query = {}) => service().links(OWNER, PROJECT, brainEntityId(...(entity.split("|") as
      ["pull_request", string])), query);
    const pr = await links("pull_request|12");
    expect(linkSummary(pr)).toEqual([
      `12-decided_in->${id("spec")}`, `${id("commitB")}-part_of->12`, `${id("githubPr")}-describes->12`,
      `${id("pr12")}-describes->12`, `${id("review")}-part_of->12`, `${id("spec")}-mentions->12`,
    ].sort());
    expect(pr.nodes[0]!.key).toBe("12");
    expect(pr.nodes).toHaveLength(6);
    expect(pr.links.find((link) => link.type === "decided_in")!.evidence).toMatchObject({
      refKind: null, quote: expect.stringContaining("#12"), cite: { kind: "spec", label: "specs/001-alpha" },
    });
    expect(linkSummary(await links("pull_request|12", { direction: "out" }))).toEqual([`12-decided_in->${id("spec")}`]);
    expect((await links("pull_request|12", { direction: "in", types: ["describes"] })).links).toHaveLength(2);
    const two = await links("pull_request|12", { hops: 2 });
    expect(two.truncated).toBe(false);
    expect(linkSummary(two)).toEqual(expect.arrayContaining([`github:carol-reviewed->${id("githubPr")}`,
      `${id("githubPr")}-references_issue->ENG-42`, `src/alpha.ts-decided_in->${id("spec")}`,
      `${id("commitB")}-changed->src/alpha.ts`, `${id("pr12")}-changed->specs/001-alpha/spec.md`]));
    expect(new Set(two.nodes.map((node) => node.entityId)).size).toBe(two.nodes.length);
    expect(linkSummary(await links("pull_request|12", { hops: 2, types: ["describes", "references_issue"] }))).toEqual([
      `${id("githubPr")}-describes->12`, `${id("githubPr")}-references_issue->ENG-42`, `${id("pr12")}-describes->12`,
      `${id("pr12")}-references_issue->#9`,
    ].sort());
    const page = await links("pull_request|12", { limit: 4 });
    const rest = await links("pull_request|12", { limit: 4, cursor: page.nextCursor! });
    expect([...page.links, ...rest.links].map((link) => link.linkId)).toEqual(pr.links.map((link) => link.linkId));
    const file = await links("file|src/alpha.ts");
    expect(linkSummary(file)).toEqual([
      `${id("commitB")}-changed->src/alpha.ts`, `${id("pr12")}-changed->src/alpha.ts`,
      `src/alpha.ts-decided_in->${id("spec")}`,
    ].sort());
    expect(linkSummary(await links("file|src/alpha.ts", { types: ["changed"], direction: "out" }))).toEqual([]);
    expect(linkSummary(await links("file|src/alpha.ts", { types: ["changed"] }))).toEqual(linkSummary(file).slice(0, 2));
    const fileTwo = linkSummary(await links("file|src/alpha.ts", { hops: 2, types: ["changed"] }));
    expect(fileTwo).toEqual([...linkSummary(file).slice(0, 2), `${id("pr12")}-changed->specs/001-alpha/spec.md`].sort());
    expect(linkSummary(await links(`document|${id("pr12")}`, { types: ["changed"], direction: "out" }))).toEqual(
      [`${id("pr12")}-changed->specs/001-alpha/spec.md`, `${id("pr12")}-changed->src/alpha.ts`]);
    expect((await links(`document|${id("pr12")}`, { types: ["changed"], direction: "in" })).links).toEqual([]);
    expect((await links("folder|src")).links).toEqual([]);
    const doc = await links(`document|${id("pr12")}`, { hops: 2 });
    expect(linkSummary(doc)).toEqual(expect.arrayContaining([`email:alice@acme.dev-authored->${id("commitB")}`,
      `${id("commitB")}-changed->src/alpha.ts`, `${id("spec")}-changed->specs/001-alpha/spec.md`]));
    await harness.db.withTables<BrainGraphTables>().deleteFrom("brain_graph_entities").where("key", "=", "#9").execute();
    const missing = await links(`document|${id("pr12")}`);
    expect(missing.links.map((link) => link.to.key)).not.toContain("#9");
    await harness.sync("github", [], [id("review")]);
    expect(linkSummary(await links("pull_request|12"))).not.toContain(`${id("review")}-part_of->12`);
    const person = await links("person|name:alice smith");
    expect(person.center.key).toBe("email:alice@acme.dev");
    expect(person.links.map((link) => link.from.key)).toContain("email:alice@acme.dev");
  });

  it("fills a two-hop node cap with authors and descriptions before newer file changes", async () => {
    await seedProject(harness);
    const paths = Array.from({ length: 150 }, (_, index) => ({ kind: "path", value: `src/big/f${index}.ts` }));
    await harness.sync("git", [{ documentId: brainDocumentId("big"), title: "chore: many files", permalink: "",
      body: gitBody("chore: many files", { sha: "e".repeat(40), author: "Zed" }), provenance: "git_commit",
      sourceUpdatedAt: "2026-09-20T10:00:00.000Z", refs: [{ kind: "path", value: "src/alpha.ts" }, ...paths] }]);
    await harness.refresh();
    const view = await service().links(OWNER, PROJECT, brainEntityId("file", "src/alpha.ts"), { hops: 2, limit: 50 });
    expect(view.truncated).toBe(true);
    expect(linkSummary(view)).toEqual(expect.arrayContaining([`name:bob jones-authored->${id("pr12")}`,
      `name:zed-authored->${brainDocumentId("big")}`, `${id("pr12")}-describes->12`]));
  });

  it("stops a page at the node cap without skipping links and truncates two hops", async () => {
    const prs = Array.from({ length: 150 }, (_, index) => ({ kind: "pr", value: String(index + 100) }));
    await harness.sync("linear", [{ ...FIXTURE.issue, refs: [...FIXTURE.issue.refs!, ...prs] }]);
    await harness.refresh();
    const links = (query: object, entity = brainEntityId("document", id("issue"))) =>
      service().links(OWNER, PROJECT, entity, query);
    const view = await links({ limit: 200 });
    expect([view.truncated, view.nodes.length, view.links.length]).toEqual([true, 100, 99]);
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let pages = 0; pages < 4 && cursor !== null; pages += 1) {
      const page = await links({ limit: 120, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.links.map((link) => link.linkId));
      cursor = page.nextCursor;
    }
    expect([cursor, seen.length, new Set(seen).size]).toEqual([null, 152, 152]);
    const two = await links({ hops: 2 }, brainEntityId("pull_request", "100"));
    expect([two.truncated, two.nodes.length, two.links.length]).toEqual([true, 100, 99]);
  });

  it("re-derives dependents: commits of a GitHub pull request and comments of a parent", async () => {
    await harness.sync("git", [FIXTURE.commitB]);
    await harness.sync("linear", [FIXTURE.comment]);
    await harness.refresh();
    expect((await service().timeline(OWNER, PROJECT, { entity: "person:name:alice smith" })).items).toHaveLength(1);
    await harness.sync("github", [FIXTURE.githubPr]);
    await harness.sync("linear", [FIXTURE.issue]);
    await harness.graph.index.handle({ type: "documents_changed", scope: SCOPE, sourceId: null,
      documentIds: [id("githubPr"), id("issue")], at: harness.iso() }, new AbortController().signal);
    expect((await harness.graph.index.freshness(SCOPE)).pendingDocuments).toBe(2);
    await harness.refresh();
    const pr = await service().timeline(OWNER, PROJECT, { entity: "pull_request:12" });
    expect(pr.items.map((item) => [item.cite.documentId, item.linkTypes])).toEqual([
      [id("githubPr"), ["describes"]], [id("commitB"), ["part_of"]],
    ]);
    const issue = await service().timeline(OWNER, PROJECT, { entity: "issue:ENG-42" });
    expect(issue.items.map((item) => item.cite.documentId)).toEqual([id("comment"), id("issue"), id("githubPr")]);
    // A revision that changes nothing dependents read nudges none; dropping the commit ref nudges the commit.
    const handle = (documentIds: string[]) => harness.graph.index.handle({ type: "documents_changed", scope: SCOPE,
      sourceId: null, documentIds, at: harness.iso() }, new AbortController().signal);
    await harness.sync("github", [{ ...FIXTURE.githubPr, title: "feat: alpha v2" }]);
    await harness.sync("linear", [{ ...FIXTURE.issue, title: "Ship alpha v2" }]);
    await handle([id("githubPr"), id("issue")]);
    expect((await harness.graph.index.freshness(SCOPE)).caughtUp).toBe(true);
    await harness.sync("github", [{ ...FIXTURE.githubPr, refs: FIXTURE.githubPr.refs!.filter((ref) => ref.kind !== "commit") }]);
    await handle([id("githubPr")]);
    expect((await harness.graph.index.freshness(SCOPE)).pendingDocuments).toBe(1);
    await harness.refresh();
    expect((await service().timeline(OWNER, PROJECT, { entity: "pull_request:12" })).items).toHaveLength(1);
  });

  it("derives a document whose parent ref names itself once", async () => {
    await harness.sync("linear", [{ ...FIXTURE.issue, refs: [...FIXTURE.issue.refs!, { kind: "parent", value: id("issue") }] }]);
    expect(await harness.refresh()).toEqual({ processed: 1, removed: 0, caughtUp: true });
  });

  it("skips a document whose write hits a foreign-key violation and rethrows anything else", async () => {
    await harness.sync("git", [FIXTURE.pr12]);
    const db = (error: unknown) => harness.db.withPlugin(failingLinks(error)).withTables<BrainGraphTables>();
    const skipping = createBrainGraphIndex({ db: db(Object.assign(new Error("fk"), { code: "23503" })), now: harness.now });
    const signal = new AbortController().signal;
    expect(await skipping.refresh(SCOPE, { documents: 1 }, signal)).toEqual({ processed: 0, removed: 0, caughtUp: false });
    const failing = createBrainGraphIndex({ db: db(new TypeError("boom")), now: harness.now });
    await expect(failing.refresh(SCOPE, {}, signal)).rejects.toThrow("boom");
    let tick = 0;
    const slow = createBrainGraphIndex({ db: db(null), now: harness.now, clock: () => (tick += 30_000) });
    expect(await slow.refresh(SCOPE, {}, signal)).toEqual({ processed: 0, removed: 0, caughtUp: false });
  });
});
