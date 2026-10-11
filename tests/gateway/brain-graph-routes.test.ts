/**
 * Graph routes over a mocked BrainGraphService: strict query and body parsing and fixed error bodies. The shared guard
 * and error mapping are tested once in brain-feature-route-kit.test.ts.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import type { BrainEntityView, BrainGraphService, BrainRefreshView } from "../../packages/gateway/src/brain/contracts.js";
import { brainEntityId, createBrainGraphRoutes } from "../../packages/gateway/src/brain/graph/index.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const BASE = "/api/brain/projects/proj_widgets";
const OWNER: RequestPrincipal = { userId: "owner_a", source: "dev-default" };
const ENTITY = brainEntityId("pull_request", "12");
const VIEW: BrainEntityView = {
  entityId: ENTITY, kind: "pull_request", key: "12", displayName: "#12", aliases: [], firstSeenAt: "x",
  lastSeenAt: "x", linkCount: 0, linkCountCapped: false,
};
const REFRESH: BrainRefreshView = {
  index: "graph", processed: 1, removed: 0, caughtUp: true,
  freshness: { caughtUp: true, pendingDocuments: 0, pendingCapped: false },
};

type ServiceMock = { [K in keyof BrainGraphService]: Mock<BrainGraphService[K]> };

function setup(options: { service?: null } = {}) {
  const service: ServiceMock = {
    timeline: vi.fn<BrainGraphService["timeline"]>(async () => ({
      entity: VIEW, items: [], nextCursor: null, freshness: REFRESH.freshness,
    })),
    listEntities: vi.fn<BrainGraphService["listEntities"]>(async () => ({ items: [], nextCursor: null })),
    getEntity: vi.fn<BrainGraphService["getEntity"]>(async () => VIEW),
    links: vi.fn<BrainGraphService["links"]>(async () => ({
      center: VIEW, hops: 1, nodes: [VIEW], links: [], truncated: false, nextCursor: null,
    })),
    updateAlias: vi.fn<BrainGraphService["updateAlias"]>(async () => VIEW),
    mergeSuggestions: vi.fn<BrainGraphService["mergeSuggestions"]>(async () => ({
      items: [], nextCursor: null, truncated: false,
    })),
    refresh: vi.fn<BrainGraphService["refresh"]>(async () => REFRESH),
  };
  const app = new Hono();
  app.route("/api/brain", createBrainGraphRoutes({
    service: options.service === null ? null : service, getPrincipal: () => OWNER,
  }));
  return { app, service };
}

async function call(app: Hono, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`http://localhost${path}`, init);
  const text = await res.text();
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(text).not.toMatch(/postgres|stack|boom/i);
  return { status: res.status, body: JSON.parse(text) };
}

const post = (body?: string): RequestInit => ({
  method: "POST", ...(body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } }),
});
const errorOf = (status: number, code: string) => expect.objectContaining({ status, body: { error: expect.objectContaining({ code }) } });

describe("brain graph routes", () => {
  let errors: MockInstance;
  beforeEach(() => { errors = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => errors.mockRestore());

  it("parses each route's query and body and calls the service with the principal", async () => {
    const { app, service } = setup();
    expect((await call(app, `${BASE}/timeline?entity=file:a.ts&linkTypes=changed,authored&limit=5&from=2026-01-01`)).status)
      .toBe(200);
    expect(service.timeline).toHaveBeenCalledWith("owner_a", "proj_widgets",
      { entity: "file:a.ts", linkTypes: ["changed", "authored"], limit: 5, from: "2026-01-01" });
    await call(app, "/api/brain/projects/widgets/entities?kind=person&q=al&cursor=abc");
    expect(service.listEntities).toHaveBeenCalledWith("owner_a", "widgets", { kind: "person", q: "al", cursor: "abc" });
    expect((await call(app, `${BASE}/entities/${ENTITY}`)).body).toEqual(VIEW);
    await call(app, `${BASE}/entities/${ENTITY}/links?hops=2&types=mentions&direction=in&limit=10`);
    expect(service.links).toHaveBeenCalledWith("owner_a", "proj_widgets", ENTITY,
      { hops: 2, types: ["mentions"], direction: "in", limit: 10 });
    await call(app, `${BASE}/entities/${ENTITY}/links?hops=1`);
    expect(service.links).toHaveBeenLastCalledWith("owner_a", "proj_widgets", ENTITY, { hops: 1 });
    const merge = JSON.stringify({ action: "merge", aliasKey: "person:github:al" });
    expect((await call(app, `${BASE}/entities/${ENTITY}/aliases`, post(merge))).status).toBe(200);
    expect(service.updateAlias).toHaveBeenCalledWith("owner_a", "proj_widgets", ENTITY,
      { action: "merge", aliasKey: "person:github:al" });
    expect((await call(app, `${BASE}/graph/refresh`, post())).body).toEqual(REFRESH);
    expect((await call(app, `${BASE}/graph/refresh`, post("{}"))).status).toBe(200);
    // Merge suggestions are part of the graph contract: the route always reaches the service.
    expect((await call(app, `${BASE}/entities/merge-suggestions?limit=5&cursor=c1`)).body)
      .toEqual({ items: [], nextCursor: null, truncated: false });
    expect(service.mergeSuggestions).toHaveBeenCalledWith("owner_a", "proj_widgets", { limit: 5, cursor: "c1" });
    expect(service.getEntity).toHaveBeenCalledTimes(1);
  });

  it("answers fixed errors for principal, availability, refs, queries and bodies", async () => {
    const { app, service } = setup();
    expect(await call(setup({ service: null }).app, `${BASE}/entities`)).toEqual(errorOf(503, "brain_unavailable"));
    expect(await call(app, "/api/brain/projects/Not_A_Project/entities")).toEqual(errorOf(404, "project_not_found"));
    expect(await call(app, `${BASE}/entities/ent_bad`)).toEqual(errorOf(404, "entity_not_found"));
    for (const query of ["timeline?entity=x&entity=y", "timeline?entity=x&extra=1", "timeline?entity=x&linkTypes=nope",
      "timeline?entity=x&limit=abc", "entities?kind=team", `entities/${ENTITY}/links?hops=3`, `entities/${ENTITY}?x=1`,
      `entities/${ENTITY}/links?direction=up`]) {
      expect(await call(app, `${BASE}/${query}`)).toEqual(errorOf(400, "invalid_request"));
    }
    expect(await call(app, `${BASE}/graph/refresh`, post('{"x":1}'))).toEqual(errorOf(400, "invalid_request"));
    expect(await call(app, `${BASE}/graph/refresh`, post("{"))).toEqual(errorOf(400, "invalid_request"));
    expect(await call(app, `${BASE}/graph/refresh?x=1`, post())).toEqual(errorOf(400, "invalid_request"));
    expect(await call(app, `${BASE}/entities/${ENTITY}/aliases`, post('{"action":"merge"}')))
      .toEqual(errorOf(400, "invalid_request"));
    expect(await call(app, `${BASE}/graph/refresh`, post(JSON.stringify({ pad: "x".repeat(2_000) }))))
      .toEqual(errorOf(413, "body_too_large"));
    expect(await call(app, `${BASE}/entities/${ENTITY}/aliases`, post(JSON.stringify({ pad: "x".repeat(3_000) }))))
      .toEqual(errorOf(413, "body_too_large"));
    const declared = { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "Content-Length": "5000" } };
    expect(await call(app, `${BASE}/graph/refresh`, declared)).toEqual(errorOf(413, "body_too_large"));
    expect(service.refresh).not.toHaveBeenCalled();
    expect(service.updateAlias).not.toHaveBeenCalled();
  });

});
