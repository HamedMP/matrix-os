/** Full-text search through the service over PGlite: ranking, weights, filters, cites, snippets, paging, notices. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { BrainSearchQuery, BrainSearchView } from "../../packages/gateway/src/brain/contracts.js";
import { sql } from "kysely";
import { hydrateBrainHits } from "../../packages/gateway/src/brain/search/hydrate.js";
import { createBrainSearch } from "../../packages/gateway/src/brain/search/index.js";
import { parseBrainSearchQuery } from "../../packages/gateway/src/brain/search/query.js";
import { rankBrainTextHits } from "../../packages/gateway/src/brain/search/text.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";
import {
  OWNER, PROJECT_ID, SCOPE, createSearchHarness, createSeeder, resolver, seedClaims, type SearchHarness,
} from "./helpers/brain-search-fakes.js";

const footer = (n: number) => `\n\nCommit: ${"a".repeat(40)}\nPull request: #${n}\nChanged paths: 1`;
const PR_BODY = `feat: alpha ledger\n\n## Invariants\n- **Source of truth:** the alpha ledger table.${footer(12)}`;

describe("brain search service", { timeout: 60_000 }, () => {
  let h: SearchHarness;
  let sourceId: string;
  let error: MockInstance<typeof console.error>;
  let warn: MockInstance<typeof console.warn>;
  let seeder: Awaited<ReturnType<typeof createSeeder>>;
  const feature = () => createBrainSearch({ repository: h.repository, resolver, capability: h.capability, now: h.now });
  const search = (query: BrainSearchQuery, ownerId = OWNER): Promise<BrainSearchView> =>
    feature().service.search(ownerId, PROJECT_ID, query);
  const ids = (view: BrainSearchView) => view.items.map((item) => item.hitId);

  beforeEach(async () => {
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h = await createSearchHarness();
    seeder = await createSeeder(h);
    sourceId = seeder.sourceId;
    await seeder.sync([
      { seed: "pr", title: "feat: alpha ledger", body: PR_BODY, provenance: "git_pr", sourceUpdatedAt: "2026-09-02T00:00:00.000Z",
        permalink: "https://github.com/acme/widgets/pull/12", refs: [{ kind: "path", value: "src/ledger/alpha.ts" }] },
      { seed: "spec", title: "Spec 549", body: "The alpha search spec mentions alpha twice.", provenance: "git_spec",
        sourceUpdatedAt: "2026-08-01T00:00:00.000Z", refs: [{ kind: "spec", value: "specs/549-search" },
          { kind: "path", value: "specs/549-search/spec.md" }] },
      { seed: "issue", title: "Billing bug", body: "Totals are wrong for some invoices.", provenance: "linear_issue",
        sourceUpdatedAt: "2026-09-10T00:00:00.000Z", refs: [{ kind: "handle", value: "ENG-42" }, { kind: "label", value: "alpha" }] },
      { seed: "note", title: "Plain note", body: "Nothing to see.", provenance: "manual" },
    ]);
    await seedClaims(h, "pr", [{ kind: "invariant", label: "Source of truth", statement: "the alpha ledger table.",
      quote: "**Source of truth:** the alpha ledger table." }]);
    await feature().service.refresh(OWNER, PROJECT_ID);
  });
  afterEach(async () => { error.mockRestore(); warn.mockRestore(); await h.destroy(); });

  it("ranks document and claim hits with cites, snippets, claims and freshness", async () => {
    const view = await search({ q: "alpha" });
    expect(view).toMatchObject({ q: "alpha", mode: "text", nextCursor: null, notices: [],
      capability: { fullText: true, vector: "extension_missing", providerId: null },
      freshness: { caughtUp: true, pendingDocuments: 0, pendingCapped: false } });
    expect(new Set(ids(view))).toEqual(new Set([brainDocumentId("pr"), brainDocumentId("spec"), brainDocumentId("issue"),
      expect.stringMatching(/^[a-f0-9]{64}$/)]));
    expect(view.items.every((item, index) => item.score >= 0 && item.score <= 1
      && (index === 0 || view.items[index - 1]!.score >= item.score))).toBe(true);
    const pr = view.items.find((item) => item.hitId === brainDocumentId("pr"))!;
    expect(pr).toMatchObject({ type: "document", matchedBy: ["text"], claim: null, cite: { kind: "pr", label: "#12",
      provenance: "git_pr", sourceId, title: "feat: alpha ledger", permalink: "https://github.com/acme/widgets/pull/12",
      date: "2026-09-02T00:00:00.000Z", revision: 1 }, snippet: { field: "body", truncatedStart: false } });
    expect(pr.snippet.highlights.map(([a, b]) => pr.snippet.text.slice(a, b))).toContain("alpha");
    const spec = view.items.find((item) => item.hitId === brainDocumentId("spec"))!;
    expect(spec.cite).toMatchObject({ kind: "spec", label: "specs/549-search" });
    const issue = view.items.find((item) => item.hitId === brainDocumentId("issue"))!;
    expect(issue).toMatchObject({ cite: { kind: "issue", label: "ENG-42" }, snippet: { field: "body", highlights: [] } });
    const claim = view.items.find((item) => item.type === "claim")!;
    expect(claim).toMatchObject({ claim: { kind: "invariant", label: "Source of truth", statement: "the alpha ledger table.",
      extractor: "rules/v1", stale: false }, cite: { label: "#12" }, snippet: { field: "statement" } });
  });

  it("weights titles above bodies and finds claim statements, phrases and prefixes", async () => {
    await seeder.sync([{ seed: "t", title: "zeta report", body: "unrelated" }, { seed: "u", title: "other", body: "zeta in body" },
      { seed: "files", body: "Edit package.json and src/brain/search.ts today." }]);
    await feature().service.refresh(OWNER, PROJECT_ID);
    expect(ids(await search({ q: "zeta" }))).toEqual([brainDocumentId("t"), brainDocumentId("u")]);
    expect(ids(await search({ q: "\"alpha ledger table\"", types: ["claim"] }))).toHaveLength(1);
    expect(ids(await search({ q: "\"table alpha\"", types: ["claim"] }))).toEqual([]);
    expect(ids(await search({ q: "invoi*" }))).toEqual([brainDocumentId("issue")]);
    const files = await search({ q: "package.js* src/brain*" });
    expect(ids(files)).toEqual([brainDocumentId("files")]);
    const { text, highlights } = files.items[0]!.snippet;
    expect(highlights.map(([a, b]) => text.slice(a, b))).toEqual(["package.json", "src/brain"]);
    expect(ids(await search({ q: "src/b*" }))).toEqual([brainDocumentId("files")]);
    expect(ids(await search({ q: "ledger", types: ["document"] }))).toEqual([brainDocumentId("pr")]);
  });

  it("filters by type, kind, claim kind, source, dates and path", async () => {
    const only = async (query: Partial<BrainSearchQuery>) => ids(await search({ q: "alpha", ...query })).sort();
    expect(await only({ types: ["document"], kinds: ["spec", "issue"] }))
      .toEqual([brainDocumentId("spec"), brainDocumentId("issue")].sort());
    expect(await only({ types: ["document"], kinds: ["document"] })).toEqual([]);
    expect(await only({ q: "nothing", kinds: ["document"] })).toEqual([brainDocumentId("note")]);
    expect(await only({ types: ["claim"], claimKinds: ["risk"] })).toEqual([]);
    expect(await only({ types: ["claim"], claimKinds: ["invariant"] })).toHaveLength(1);
    expect(await only({ sourceId: `src_${"0".repeat(32)}` })).toEqual([]);
    expect(await only({ types: ["document"], from: "2026-09-01", to: "2026-09-05" })).toEqual([brainDocumentId("pr")]);
    expect(await only({ path: "src/ledger/" })).toHaveLength(2);
    expect(await only({ path: "specs/549-search/spec.md", types: ["document"] })).toEqual([brainDocumentId("spec")]);
  });

  it("pages with keyset cursors that only continue the same query", async () => {
    const all = ids(await search({ q: "alpha" }));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await search({ q: "alpha", limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...ids(page));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(all);
    const first = await search({ q: "alpha", limit: 1 });
    await expect(search({ q: "ledger", limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_request" });
    // A query with no term left to rank still checks its cursor.
    for (const cursor of ["garbage", "!", first.nextCursor!]) {
      for (const mode of ["text", "auto"] as const) {
        await expect(search({ q: "!!!", mode, cursor })).rejects.toMatchObject({ code: "invalid_request" });
      }
    }
  });

  it("reports empty queries, dropped terms, a lagging index, stale claims and missing projects", async () => {
    expect(await search({ q: "!!! ***" })).toMatchObject({ items: [], nextCursor: null, notices: ["query_empty_after_parse"] });
    const many = Array.from({ length: 17 }, () => "alpha").join(" ");
    expect((await search({ q: many })).notices).toEqual(["terms_dropped"]);
    await seeder.sync([{ seed: "pr", title: "feat: alpha ledger", body: `${PR_BODY}\nmore alpha`, provenance: "git_pr" }]);
    const lagging = await search({ q: "alpha", types: ["claim"] });
    expect(lagging.notices).toEqual(["index_behind"]);
    expect(lagging.freshness).toEqual({ caughtUp: false, pendingDocuments: 1, pendingCapped: false });
    expect(lagging.items[0]!.claim!.stale).toBe(true);
    await expect(search({ q: "alpha" }, "owner_b")).rejects.toMatchObject({ code: "project_not_found" });
    await expect(search({ q: "alpha", mode: "hybrid" })).rejects.toMatchObject({ code: "vector_search_unavailable" });
    await expect(search({ q: "" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("shows a claim held by two extractors once, as the model's, and falls back to any term when few match all", async () => {
    await seedClaims(h, "pr", [{ kind: "invariant", label: "Source of truth", statement: "the alpha ledger table.",
      quote: "**Source of truth:** the alpha ledger table." }], "model:claude-opus-5-5/claims-v2");
    await feature().service.refresh(OWNER, PROJECT_ID);
    const claims = (await search({ q: "ledger", types: ["claim"] })).items;
    expect(claims.map((item) => [item.hitId, item.claim!.extractor])).toEqual([
      [claims[0]!.claim!.claimId, "model:claude-opus-5-5/claims-v2"],
    ]);
    const fallback = await search({ q: "invoices zebra" });
    expect([ids(fallback), fallback.notices]).toEqual([[brainDocumentId("issue")], ["any_term_fallback"]]);
    expect((await search({ q: "invoices zebra", limit: 1 })).notices).toEqual(["any_term_fallback"]);
    expect(new Set(ids(await search({ q: "ledger alpha", types: ["document"] })))).toEqual(new Set([
      brainDocumentId("pr"), brainDocumentId("spec"), brainDocumentId("issue")]));
    expect((await search({ q: "ledger" })).notices).toEqual([]);
  });

  it("shows the label of a claim matched only by its label, highlighted", async () => {
    await seedClaims(h, "issue", [{ kind: "risk", label: "Billing guard", statement: "Totals are wrong",
      quote: "Totals are wrong" }]);
    await feature().service.refresh(OWNER, PROJECT_ID);
    const [hit] = (await search({ q: "guard", types: ["claim"] })).items;
    expect(hit!.snippet).toEqual({ field: "label", text: "Billing guard", highlights: [[8, 13]], truncatedStart: false,
      truncatedEnd: false });
    expect((await search({ q: "totals", types: ["claim"] })).items[0]!.snippet.field).toBe("statement");
  });

  it("removes tombstoned documents on refresh and drops hits that went away before hydration", async () => {
    await seeder.sync([], ["note"]);
    expect((await search({ q: "alpha" })).freshness).toEqual({ caughtUp: false, pendingDocuments: 1, pendingCapped: false });
    expect(await feature().service.refresh(OWNER, PROJECT_ID)).toEqual({ index: "search", processed: 0, removed: 1,
      caughtUp: true, freshness: { caughtUp: true, pendingDocuments: 0, pendingCapped: false } });
    expect([feature().service.capability(), feature().index.name]).toEqual([h.capability, "search"]);
    const hit = (documentId: string, type: "document" | "claim", chunkIndex: number | null) => ({ type, documentId,
      hitId: type === "claim" ? `${"c".repeat(64)}:rules/v1` : documentId, claimId: type === "claim" ? "c".repeat(64) : null,
      extractor: type === "claim" ? "rules/v1" : null, score: "0.500000", matchedBy: ["vector" as const], chunkIndex });
    const views = await hydrateBrainHits(h.db, SCOPE, [hit(brainDocumentId("note"), "document", 0),
      hit(brainDocumentId("pr"), "claim", null), hit(brainDocumentId("spec"), "document", 39)], []);
    expect(views.map((view) => [view.hitId, view.snippet.field, view.snippet.truncatedStart]))
      .toEqual([[brainDocumentId("spec"), "body", false]]);
    expect(await hydrateBrainHits(h.db, SCOPE, [hit(brainDocumentId("note"), "document", 0)], [])).toEqual([]);
    // A claim removed by re-extraction keeps its search row until refresh but never ranks.
    await seedClaims(h, "pr", []);
    expect(await rankBrainTextHits(h.db, SCOPE, parseBrainSearchQuery({ q: "alpha", types: ["claim"] }),
      { limit: 10, after: null })).toEqual([]);
  });

  it("keeps ranking, hydration, refresh, freshness and erase inside the scope", async () => {
    const before = await search({ q: "alpha" });
    const { index } = feature();
    const others = [{ ownerId: "owner_b", scopeId: SCOPE.scopeId }, { ownerId: OWNER, scopeId: "personal:project:other" }];
    for (const scope of others) {
      await (await createSeeder(h, scope)).sync([
        { seed: "pr", title: "theirs", body: "alpha elsewhere", provenance: "git_pr" },
        { seed: "spec", title: "theirs", body: "alpha", provenance: "git_spec", refs: [{ kind: "handle", value: "OTHER-2" },
          { kind: "path", value: "src/ledger/beta.ts" }] },
        { seed: "extra", body: "alpha extra" }]);
      await seedClaims(h, "pr", [{ kind: "invariant", label: "Source of truth", statement: "the alpha ledger table.",
        quote: "alpha elsewhere" }], "rules/v1", scope);
      expect(await index.freshness(scope)).toMatchObject({ pendingDocuments: 3 });
    }
    expect(await search({ q: "alpha" })).toEqual(before);
    expect(await feature().service.refresh(OWNER, PROJECT_ID)).toMatchObject({ processed: 0, removed: 0, caughtUp: true });
    for (const scope of others) expect(await index.refresh(scope, {}, AbortSignal.timeout(30_000))).toMatchObject({ processed: 3 });
    expect(await search({ q: "alpha" })).toEqual(before);
    expect((await search({ q: "alpha", path: "src/ledger/" })).items).toHaveLength(2);
    await index.handle({ type: "scope_erased", scope: SCOPE, at: h.iso() }, AbortSignal.timeout(30_000));
    const counts = await sql<{ owner_id: string; scope_id: string; n: number }>`SELECT owner_id, scope_id, count(*)::int AS n
      FROM brain_search_documents GROUP BY owner_id, scope_id ORDER BY owner_id, scope_id`.execute(h.db);
    expect(counts.rows).toEqual([{ owner_id: OWNER, scope_id: "personal:project:other", n: 3 },
      { owner_id: "owner_b", scope_id: SCOPE.scopeId, n: 3 }]);
  });
});
