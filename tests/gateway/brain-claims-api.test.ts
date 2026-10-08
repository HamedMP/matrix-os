/** POST /extract and GET /claims on a real service over PGlite; only owner_a sees the project; no-store, no leaks. */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createBrainProjectService } from "../../packages/gateway/src/brain/api/service.js";
import { createBrainRoutes } from "../../packages/gateway/src/brain/api/routes.js";
import {
  BRAIN_API_ERRORS, brainApiErrorBody, brainProjectScope, type BrainApiErrorCode, type BrainProjectLookup, type BrainProjectServiceDeps,
} from "../../packages/gateway/src/brain/api/index.js";
import { BRAIN_RULES_EXTRACTOR_ID as RULES } from "../../packages/gateway/src/brain/claims/index.js";
import type { ProjectConfig } from "../../packages/gateway/src/project-manager.js";
import { brainContent, createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";

const OWNER = "owner_a";
const PROJECT_ID = "proj_widgets";
const SCOPE = brainProjectScope(OWNER, PROJECT_ID);
const BASE = `/api/brain/projects/${PROJECT_ID}`;
const LEAK = /postgres|stack|\/home\/|stderr|relation |violates/i;
const AT = "2026-10-01T10:00:00.000Z";
const prBody = (truth: string) => ["feat: alpha (#12)", "", "## Invariants", `- **Source of truth:** ${truth}.`,
  "- **Acceptable orphan states:** a running row until its lease expires.", "", `Commit: ${"a".repeat(40)}`,
  "Pull request: #12", "Changed paths: 1"].join("\n");
const NOTE_BODY = "## Decisions\n- Keep one transaction per document.";
const PROJECT = { id: PROJECT_ID, name: "Widgets", slug: "widgets", kind: "folder", localPath: "/tmp/widgets", addedAt: AT,
  updatedAt: AT, ownerScope: { type: "user", id: OWNER } } as ProjectConfig;
const missing = { ok: false, status: 404, error: { code: "not_found", message: "Project was not found" } } as const;
const projects = {
  getProjectById: async (scope, id) => (scope?.id === OWNER && id === PROJECT_ID ? { ok: true, project: PROJECT } : missing),
  getProject: async () => missing, resolveProjectWorkingDirectory: async () => null,
} as BrainProjectLookup;

const failure = (code: BrainApiErrorCode) => ({ status: BRAIN_API_ERRORS[code].status, body: brainApiErrorBody(code) });

describe("brain claims api", { timeout: 60_000 }, () => {
  let h: BrainHarness;
  let sourceId: string;
  let errorLog: MockInstance<typeof console.error>;
  beforeEach(async () => {
    h = await createBrainHarness();
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const external = { kind: "git", externalRef: "https://github.com/acme/widgets", label: "Widgets" } as const;
    ({ source: { sourceId } } = await h.repository.createSource(SCOPE, external));
    await sync(null, "c1", "the brain_claims table");
  });
  afterEach(async () => { errorLog.mockRestore(); await h.destroy(); });

  async function sync(expectedCursor: string | null, nextCursor: string, truth: string): Promise<void> {
    await h.repository.applySyncBatch(SCOPE, { sourceId, expectedCursor, nextCursor, deletions: [], upserts: [
      { ...brainContent("pr", { title: "feat: alpha", body: prBody(truth), provenance: "git_pr",
        permalink: "https://github.com/acme/widgets/pull/12", sourceUpdatedAt: "2026-09-02T00:00:00.000Z" }),
      refs: [{ kind: "path", value: "src/alpha.ts" }] },
      { ...brainContent("note", { body: NOTE_BODY, sourceUpdatedAt: "2026-09-01T00:00:00.000Z" }),
        refs: [{ kind: "path", value: "src/alpha-b.ts" }] },
    ] });
  }

  const service = (extra: Partial<BrainProjectServiceDeps> = {}) =>
    createBrainProjectService({ repository: h.repository, projects, homePath: "/tmp", ...extra });
  const app = (extra: Partial<BrainProjectServiceDeps> = {}, withService = true): Hono => new Hono().route("/api/brain",
    createBrainRoutes({ service: withService ? service(extra) : null, getPrincipal: () => ({ userId: OWNER, source: "dev-default" }) }));

  async function call(target: Hono, path: string, body?: string): Promise<{ status: number; body: any }> {
    const init = body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } };
    const res = await target.request(`http://localhost${path}`, path.includes("/extract") ? { method: "POST", ...init } : {});
    const text = await res.text();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(text).not.toMatch(LEAK);
    return { status: res.status, body: JSON.parse(text) };
  }

  it("runs one bounded rules extraction and lists claims with document labels, filters and keyset pages", async () => {
    const api = app();
    const extracted = await call(api, `${BASE}/extract`);
    expect(extracted).toMatchObject({ status: 200, body: {
      status: "succeeded", errorCode: null, nextAction: "", extractor: RULES, caughtUp: true,
      counts: { documentsProcessed: 2, claimsWritten: 3 }, run: { status: "succeeded", runId: expect.stringMatching(/^xrn_/) },
    } });
    expect(extracted.body.run).not.toHaveProperty("scopeId");

    const all = (await call(api, `${BASE}/claims`)).body;
    expect([all.kind, all.path, all.match, all.nextCursor, all.items.length]).toEqual([null, null, null, null, 3]);
    expect(all.items[0]).toMatchObject({
      kind: "invariant", label: "Source of truth", statement: "the brain_claims table.",
      quote: "**Source of truth:** the brain_claims table.", extractor: RULES, revision: 1, stale: false,
      document: { kind: "pr", label: "#12", title: "feat: alpha", permalink: "https://github.com/acme/widgets/pull/12",
        date: "2026-09-02T00:00:00.000Z", revision: 1 },
    });
    expect(all.items[2]).toMatchObject({ kind: "decision", document: { kind: "document", label: "Title note" } });

    const kinds = async (query: string) => (await call(api, `${BASE}/claims?${query}`)).body.items.map((i: any) => i.kind);
    expect(await kinds("kind=decision")).toEqual(["decision"]);
    expect(await kinds("path=src/alpha.ts")).toEqual(["invariant", "invariant"]);
    expect(await kinds("path=src/alpha")).toEqual([]);
    expect(await kinds("path=src/")).toHaveLength(3);
    expect((await call(api, `${BASE}/claims?path=src/`)).body).toMatchObject({ path: "src", match: "folder" });

    const first = (await call(api, `${BASE}/claims?limit=2`)).body;
    const rest = (await call(api, `${BASE}/claims?limit=2&cursor=${first.nextCursor}`)).body;
    expect([...first.items, ...rest.items].map((i: any) => i.claimId)).toEqual(all.items.map((i: any) => i.claimId));

    await sync("c1", "c2", "the brain_documents table");
    const stale = (await call(api, `${BASE}/claims?path=src/alpha.ts`)).body.items;
    expect(stale.map((i: any) => [i.stale, i.revision, i.document.revision])).toEqual([[true, 1, 2], [true, 1, 2]]);
    // Commits are labelled by short sha; pull requests and commits without a footer fall back.
    await h.repository.applySyncBatch(SCOPE, { sourceId, expectedCursor: "c2", nextCursor: "c3", deletions: [], upserts: [
      brainContent("commit", { provenance: "git_commit", body: `${NOTE_BODY}\n\nCommit: ${"b".repeat(40)}` }),
      brainContent("bare", { provenance: "git_commit", body: NOTE_BODY }),
      brainContent("pr0", { provenance: "git_pr", body: NOTE_BODY }),
      // A pull request footer without a number shows its short sha, as every cite does.
      brainContent("pr1", { provenance: "git_pr", body: `${NOTE_BODY}\n\nCommit: ${"d".repeat(40)}` }),
    ] });
    await call(api, `${BASE}/extract`);
    const labels = (await call(api, `${BASE}/claims?kind=decision`)).body.items.map((item: any) => item.document.label);
    expect(labels.sort()).toEqual(["PR", "Title note", "b".repeat(12), "commit", "d".repeat(12)]);
  });

  it("reports the owner's model spend over the last 30 days, every project, next to the claims, only with a cap", async () => {
    expect((await call(app(), `${BASE}/claims`)).body.modelSpend).toBeNull();
    const runAt = new Date(h.now().getTime() - 86_400_000);
    for (const [scope, cost] of [[SCOPE, 1_250_000], [brainProjectScope(OWNER, "proj_other"), 9_000_000]] as const) {
      await h.db.insertInto("brain_extraction_runs").values({
        owner_id: scope.ownerId, scope_id: scope.scopeId, run_id: `xrn_${String(cost).padStart(32, "0")}`,
        extractor: "model:claude-opus-5-5/claims-v2", status: "succeeded", cost_microusd: cost, error_code: null,
        started_at: runAt, finished_at: runAt,
      }).execute();
    }
    const capped = (await call(app({ modelSpendCapMicroUsd: 5_000_000 }), `${BASE}/claims?kind=risk`)).body;
    expect(capped.modelSpend).toEqual({
      windowStart: new Date(h.now().getTime() - 30 * 86_400_000).toISOString(), capMicroUsd: 5_000_000,
      spentMicroUsd: 10_250_000, remainingMicroUsd: 0,
    });
    // Another owner's spend never counts.
    await h.db.deleteFrom("brain_extraction_runs").where("scope_id", "!=", SCOPE.scopeId).execute();
    await h.db.insertInto("brain_extraction_runs").values({
      owner_id: "owner_elsewhere", scope_id: SCOPE.scopeId, run_id: `xrn_${"e".repeat(32)}`,
      extractor: "model:claude-opus-5-5/claims-v2", status: "succeeded", cost_microusd: 4_000_000, error_code: null,
      started_at: runAt, finished_at: runAt,
    }).execute();
    expect((await call(app({ modelSpendCapMicroUsd: 5_000_000 }), `${BASE}/claims`)).body.modelSpend)
      .toMatchObject({ spentMicroUsd: 1_250_000, remainingMicroUsd: 3_750_000 });
  });

  it("refuses the model extractor, a running extraction and runless failures", async () => {
    expect(await call(app(), `${BASE}/extract`, JSON.stringify({ extractor: "model" }))).toEqual(failure("extractor_not_configured"));
    await h.repository.openExtractionRun(SCOPE, { extractor: RULES });
    expect(await call(app(), `${BASE}/extract`, "{}")).toEqual(failure("extraction_in_progress"));
    const extract = vi.fn(async () => ({ status: "failed", errorCode: "store_unavailable", run: null }) as never);
    expect(await call(app({ extract }), `${BASE}/extract`, JSON.stringify({ extractor: "rules" }))).toEqual(failure("brain_unavailable"));
    expect(errorLog).toHaveBeenCalledWith("[brain-api] extraction could not record a run:", "store_unavailable");
    const unrecorded = vi.fn(async () => ({ status: "succeeded", errorCode: null, run: null }) as never);
    expect((await call(app({ extract: unrecorded }), `${BASE}/extract`)).body).toEqual({ status: "succeeded", errorCode: null, run: null });
    await expect(service().listClaims(OWNER, PROJECT_ID, { path: "/etc", limit: 1 })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it.each([
    ["unknown extractor", "extract", JSON.stringify({ extractor: "x" })],
    ["unknown body key", "extract", JSON.stringify({ extractor: "rules", force: true })],
    ["invalid JSON", "extract", "{"], ["unknown query key", "claims?bogus=1", undefined],
    ["bad kind", "claims?kind=bogus", undefined], ["limit 101", "claims?limit=101", undefined],
    ["absolute path", "claims?path=%2Fetc", undefined], ["bad cursor", "claims?cursor=not-a-cursor", undefined],
    ["duplicate key", "claims?kind=risk&kind=decision", undefined],
  ])("400 for %s", async (_label, route, body) => {
    expect(await call(app(), `${BASE}/${route}`, body)).toEqual(failure("invalid_request"));
  });

  it("answers 413, 404 and 503 like the other brain routes", async () => {
    expect(await call(app(), `${BASE}/extract`, JSON.stringify({ extractor: "x".repeat(2048) }))).toEqual(failure("body_too_large"));
    for (const route of ["extract", "claims"]) {
      expect(await call(app(), `/api/brain/projects/proj_other/${route}`)).toEqual(failure("project_not_found"));
      expect(await call(app({}, false), `${BASE}/${route}`)).toEqual(failure("brain_unavailable"));
    }
  });
});
