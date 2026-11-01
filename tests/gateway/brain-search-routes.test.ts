/** GET /search and POST /search/refresh: availability, project refs, query parsing and no-store (guard: kit test). */
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrainSearchQuery, BrainSearchService } from "../../packages/gateway/src/brain/contracts.js";
import { createBrainSearch, createBrainSearchRoutes } from "../../packages/gateway/src/brain/search/index.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import {
  OWNER, PROJECT_ID, createSearchHarness, createSeeder, resolver, type SearchHarness,
} from "./helpers/brain-search-fakes.js";

const BASE = `/api/brain/projects/${PROJECT_ID}`;
const LEAK = /postgres|stack|relation |violates|provider down/i;
const owner = (): RequestPrincipal => ({ userId: OWNER, source: "dev-default" });

function app(service: BrainSearchService | null, getPrincipal: () => RequestPrincipal = owner): Hono {
  return new Hono().route("/api/brain", createBrainSearchRoutes({ service, getPrincipal }));
}

async function call(target: Hono, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await target.request(`http://localhost${path}`, init);
  const text = await response.text();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(text).not.toMatch(LEAK);
  return { status: response.status, body: JSON.parse(text) };
}

const throwing = (error: unknown): BrainSearchService => ({
  search: async () => { throw error; }, refresh: async () => { throw error; },
  capability: () => ({ fullText: true, vector: "extension_missing", providerId: null }),
});

describe("brain search routes", { timeout: 60_000 }, () => {
  let h: SearchHarness;
  let real: Hono;
  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h = await createSearchHarness();
    const seeder = await createSeeder(h);
    await seeder.sync([{ seed: "a", title: "Alpha ledger", body: "alpha body", provenance: "git_pr" }]);
    real = app(createBrainSearch({ repository: h.repository, resolver, capability: h.capability }).service);
  });
  afterAll(async () => { vi.restoreAllMocks(); await h.destroy(); });

  it("refreshes and searches with list filters by id or slug", async () => {
    expect(await call(real, `${BASE}/search/refresh`, { method: "POST" })).toMatchObject({ status: 200,
      body: { index: "search", processed: 1, removed: 0, caughtUp: true } });
    expect((await call(real, `${BASE}/search/refresh`, { method: "POST", body: "{}",
      headers: { "Content-Type": "application/json" } })).status).toBe(200);
    const found = await call(real, `${BASE}/search?q=alpha&types=document,claim&kinds=pr,commit&limit=5&mode=text`);
    expect(found).toMatchObject({ status: 200, body: { q: "alpha", mode: "text", items: [{ type: "document" }] } });
    const slug = await call(real, "/api/brain/projects/widgets/search?q=alpha&from=2026-01-01&to=2027-01-01&path=src/");
    expect(slug).toMatchObject({ status: 200, body: { items: [] } });
  });

  it("refuses malformed queries and bodies with fixed codes", async () => {
    for (const query of ["", "?q=a&q=b", "?q=a&nope=1", "?q=a&types=document,nope", "?q=a&limit=0", "?q=a&mode=fast",
      `?q=a&kinds=${"pr,".repeat(100)}pr`, "?q=a&source=src_bad", "?q=a&cursor=%2B%2B", "?q=a&from=bad"]) {
      expect(await call(real, `${BASE}/search${query}`)).toEqual({ status: 400,
        body: { error: { code: "invalid_request", message: "Invalid brain request" } } });
    }
    const post = (body: string) => call(real, `${BASE}/search/refresh`, { method: "POST", body,
      headers: { "Content-Type": "application/json" } });
    expect((await post("{\"a\":1}")).status).toBe(400);
    expect((await post("{nope")).status).toBe(400);
    expect(await post(JSON.stringify({ pad: "x".repeat(2_000) }))).toMatchObject({ status: 413,
      body: { error: { code: "body_too_large" } } });
    expect(await call(real, `${BASE}/search/refresh`, { method: "POST", body: "x".repeat(2_000),
      headers: { "Content-Type": "application/json", "Content-Length": "2000" } })).toMatchObject({ status: 413 });
  });

  it("checks the principal, then availability, then the project reference", async () => {
    expect(await call(app(null), `${BASE}/search?q=a`)).toMatchObject({ status: 503,
      body: { error: { code: "brain_unavailable", message: "Company brain is unavailable" } } });
    expect(await call(real, "/api/brain/projects/Bad_Ref!/search?q=a")).toMatchObject({ status: 404,
      body: { error: { code: "project_not_found" } } });
    expect(await call(real, "/api/brain/projects/proj_other/search?q=a")).toMatchObject({ status: 404 });
  });

  it("passes list filters and the source id through to the service", async () => {
    const seen: BrainSearchQuery[] = [];
    const recording = { ...throwing(null), search: async (_owner: string, _ref: string, query: BrainSearchQuery) => {
      seen.push(query);
      return {} as never;
    } };
    await call(app(recording), `${BASE}/search?q=a&source=src_${"0".repeat(32)}&claimKinds=risk`);
    expect(seen[0]).toEqual({ q: "a", sourceId: `src_${"0".repeat(32)}`, claimKinds: ["risk"] });
  });
});
