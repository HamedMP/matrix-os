import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_ROUTES, BrainFeatureError, type BrainSourcesService, type BrainSourceView,
} from "../../packages/gateway/src/brain/contracts.js";
import { BrainStoreError } from "../../packages/gateway/src/brain/types.js";
import {
  InvalidRequestPrincipalError, RequestPrincipalMisconfiguredError,
} from "../../packages/gateway/src/request-principal.js";
import {
  createBrainSourcesRoutes, createBrainSourcesService, runBrainSourceSync,
} from "../../packages/gateway/src/brain/sources/core/index.js";
import { fakeHandler, OWNER, sourcesHarness } from "./helpers/brain-sources-fixture.js";

const SOURCE = `src_${"a".repeat(32)}`;
const BASE = "/api/brain/projects/proj_a/sources";
const view = { sourceId: SOURCE, kind: "linear", revision: 1 } as unknown as BrainSourceView;

function fakeService(overrides: Partial<BrainSourcesService> = {}): BrainSourcesService {
  return {
    list: vi.fn(async () => ({ items: [], kinds: [] })),
    connect: vi.fn(async () => ({ source: view, created: true })),
    options: vi.fn(async () => ({ kind: "linear" as const, items: [], nextCursor: null })),
    update: vi.fn(async () => view),
    remove: vi.fn(async () => view),
    sync: vi.fn(async () => ({ sourceId: SOURCE }) as never),
    receipts: vi.fn(async () => ({ source: view, receipts: [] })),
    ...overrides,
  };
}

function app(service: BrainSourcesService | null, principal: () => unknown = () => ({ userId: OWNER, source: "dev-default" })) {
  const root = new Hono();
  root.route("/api/brain", createBrainSourcesRoutes({ service, getPrincipal: principal as never }));
  return root;
}

async function call(root: Hono, path: string, init?: RequestInit) {
  const response = await root.request(path, init);
  return { status: response.status, body: await response.json() as unknown, cache: response.headers.get("cache-control") };
}
const json = (method: string, body: unknown, headers: Record<string, string> = {}) =>
  ({ method, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const errorOf = (status: number, code: string) => expect.objectContaining({ status, body: { error: { code, message: expect.any(String) } } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sources routes", () => {
  it("serves exactly the seven /sources routes of the route table", () => {
    const specs = BRAIN_ROUTES.filter((route) => route.owner === "connectors").map((route) => `${route.method} ${route.path}`);
    expect(specs).toEqual([
      "GET /projects/:projectId/sources", "POST /projects/:projectId/sources", "GET /projects/:projectId/sources/options",
      "PATCH /projects/:projectId/sources/:sourceId", "DELETE /projects/:projectId/sources/:sourceId",
      "POST /projects/:projectId/sources/:sourceId/sync", "GET /projects/:projectId/sources/:sourceId/receipts",
    ]);
  });

  it("passes parsed input to the service and answers 201 only for a created source", async () => {
    const service = fakeService();
    const root = app(service);
    expect(await call(root, BASE)).toMatchObject({ status: 200, cache: "private, no-store" });
    expect(service.list).toHaveBeenCalledWith(OWNER, "proj_a");
    const created = await call(root, BASE, json("POST", { kind: "linear", config: { teamKeys: ["ENG"] }, label: " Eng " }));
    expect(created).toMatchObject({ status: 201, body: { created: true } });
    expect(service.connect).toHaveBeenCalledWith(OWNER, "proj_a", { kind: "linear", config: { teamKeys: ["ENG"] }, label: "Eng" });
    vi.mocked(service.connect).mockResolvedValueOnce({ source: view, created: false });
    expect((await call(root, BASE, json("POST", { kind: "matrix_notes", config: {} }))).status).toBe(200);
    await call(root, `${BASE}/options?kind=google_drive&q=plans&cursor=abc`);
    expect(service.options).toHaveBeenCalledWith(OWNER, "proj_a", "google_drive", { q: "plans", cursor: "abc" });
    await call(root, `/api/brain/projects/alpha/sources/options?kind=linear`);
    expect(service.options).toHaveBeenLastCalledWith(OWNER, "alpha", "linear", {});
    await call(root, `${BASE}/${SOURCE}`, json("PATCH", { expectedRevision: 3, status: "paused", config: { a: 1 }, label: "x" }));
    expect(service.update).toHaveBeenCalledWith(OWNER, "proj_a", SOURCE, { expectedRevision: 3, status: "paused", config: { a: 1 }, label: "x" });
    await call(root, `${BASE}/${SOURCE}`, json("PATCH", { expectedRevision: 4, status: "active" }));
    expect(service.update).toHaveBeenLastCalledWith(OWNER, "proj_a", SOURCE, { expectedRevision: 4, status: "active" });
    await call(root, `${BASE}/${SOURCE}?expectedRevision=4`, { method: "DELETE" });
    expect(service.remove).toHaveBeenCalledWith(OWNER, "proj_a", SOURCE, 4);
    await call(root, `${BASE}/${SOURCE}?expectedRevision=5`, json("DELETE", {}));
    expect(service.remove).toHaveBeenLastCalledWith(OWNER, "proj_a", SOURCE, 5);
    await call(root, `${BASE}/${SOURCE}/sync`, { method: "POST" });
    expect(service.sync).toHaveBeenCalledWith(OWNER, "proj_a", SOURCE);
    await call(root, `${BASE}/${SOURCE}/receipts`);
    expect(service.receipts).toHaveBeenCalledWith(OWNER, "proj_a", SOURCE, 10);
    await call(root, `${BASE}/${SOURCE}/receipts?limit=50`);
    expect(service.receipts).toHaveBeenLastCalledWith(OWNER, "proj_a", SOURCE, 50);
    // Path ids that fail BRAIN_SOURCE_ID_PATTERN reach the service as "" on every source route, after its project check.
    for (const bad of ["x".repeat(80), "src_bad", `src_${"A".repeat(32)}`, `src_${"a".repeat(33)}`, `${SOURCE}%20`]) {
      await call(root, `${BASE}/${bad}`, json("PATCH", { expectedRevision: 1, label: "x" }));
      await call(root, `${BASE}/${bad}?expectedRevision=1`, { method: "DELETE" });
      await call(root, `${BASE}/${bad}/sync`, { method: "POST" });
      await call(root, `${BASE}/${bad}/receipts`);
      for (const method of ["update", "remove", "sync", "receipts"] as const) expect(vi.mocked(service[method]).mock.lastCall?.[2]).toBe("");
    }
  });

  it("answers the principal, availability and project ref errors on every route before any service call", async () => {
    const routes: [string, RequestInit?][] = [
      [BASE], [BASE, json("POST", { kind: "linear", config: {} })], [`${BASE}/options?kind=linear`],
      [`${BASE}/${SOURCE}`, json("PATCH", { expectedRevision: 1, label: "x" })], [`${BASE}/${SOURCE}?expectedRevision=1`, { method: "DELETE" }],
      [`${BASE}/${SOURCE}/sync`, { method: "POST" }], [`${BASE}/${SOURCE}/receipts`],
    ];
    const service = fakeService();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [path, init] of routes) {
      expect(await call(app(service, () => { throw new InvalidRequestPrincipalError("jwt" as never); }), path, init))
        .toMatchObject({ status: 401, body: { error: "Unauthorized" }, cache: "private, no-store" });
      expect((await call(app(service, () => { throw new RequestPrincipalMisconfiguredError(); }), path, init)).status).toBe(500);
      expect(await call(app(null), path, init)).toEqual(errorOf(503, "brain_unavailable"));
      expect(await call(app(service), path.replace("proj_a", "Not_A_Project"), init)).toEqual(errorOf(404, "project_not_found"));
    }
    expect(error).toHaveBeenCalled();
    for (const method of Object.keys(service) as (keyof BrainSourcesService)[]) expect(service[method]).not.toHaveBeenCalled();
  });

  it("refuses bad queries, bodies and kinds with generic codes", async () => {
    const service = fakeService();
    const root = app(service);
    for (const path of [`${BASE}?x=1`, `${BASE}/options`, `${BASE}/options?kind=linear&kind=linear`, `${BASE}/options?kind=Linear`,
      `${BASE}/options?kind=linear&q=${"q".repeat(257)}`, `${BASE}/options?kind=linear&cursor=`, `${BASE}/${SOURCE}/receipts?limit=0`,
      `${BASE}/${SOURCE}/receipts?limit=51`, `${BASE}/${SOURCE}/receipts?limit=1e1`]) {
      expect(await call(root, path)).toEqual(errorOf(400, "invalid_request"));
    }
    expect(await call(root, `${BASE}/options?kind=git`)).toEqual(errorOf(400, "source_kind_unsupported"));
    expect(await call(root, `${BASE}/options?kind=slack`)).toEqual(errorOf(400, "source_kind_unsupported"));
    for (const body of ["{", "[]", { kind: "linear" }, { kind: "linear", config: {}, extra: 1 }, { kind: "linear", config: {}, label: "" },
      { kind: "linear", config: {}, label: "a\u0007b" }, { kind: 1, config: {} }]) {
      expect(await call(root, BASE, json("POST", body))).toEqual(errorOf(400, "invalid_request"));
    }
    expect(await call(root, BASE, json("POST", { kind: "git", config: {} }))).toEqual(errorOf(400, "source_kind_unsupported"));
    expect(await call(root, `${BASE}?x=1`, json("POST", { kind: "linear", config: {} }))).toEqual(errorOf(400, "invalid_request"));
    for (const body of [{}, { expectedRevision: 1 }, { expectedRevision: 0, label: "x" }, { expectedRevision: 1, status: "disabled" },
      { expectedRevision: "1", label: "x" }, { expectedRevision: 1, label: "x", extra: true }]) {
      expect(await call(root, `${BASE}/${SOURCE}`, json("PATCH", body))).toEqual(errorOf(400, "invalid_request"));
    }
    for (const path of [`${BASE}/${SOURCE}`, `${BASE}/${SOURCE}?expectedRevision=0`, `${BASE}/${SOURCE}?expectedRevision=-1`,
      `${BASE}/${SOURCE}?expectedRevision=1&x=1`]) {
      expect(await call(root, path, { method: "DELETE" })).toEqual(errorOf(400, "invalid_request"));
    }
    expect(await call(root, `${BASE}/${SOURCE}?expectedRevision=1`, json("DELETE", { force: true }))).toEqual(errorOf(400, "invalid_request"));
    expect(await call(root, `${BASE}/${SOURCE}/sync`, json("POST", { now: true }))).toEqual(errorOf(400, "invalid_request"));
    expect(await call(root, `${BASE}/${SOURCE}/sync?x=1`, { method: "POST" })).toEqual(errorOf(400, "invalid_request"));
    for (const method of ["connect", "update", "remove", "sync", "receipts", "options"] as const) expect(service[method]).not.toHaveBeenCalled();
  });

  it("limits every mutating body by its route bound, sent or declared", async () => {
    const service = fakeService();
    const root = app(service);
    const pad = (bytes: number) => ({ kind: "linear", config: { pad: "x".repeat(bytes) } });
    const routes: [string, string, number][] = [
      [BASE, "POST", 16_384], [`${BASE}/${SOURCE}`, "PATCH", 16_384], [`${BASE}/${SOURCE}?expectedRevision=1`, "DELETE", 1_024],
      [`${BASE}/${SOURCE}/sync`, "POST", 1_024],
    ];
    for (const [path, method, max] of routes) {
      expect(BRAIN_ROUTES.some((route) => route.method === method && route.bodyMaxBytes === max)).toBe(true);
      expect(await call(root, path, json(method, pad(max)))).toEqual(errorOf(413, "body_too_large"));
      expect(await call(root, path, json(method, "{}", { "content-length": String(max + 1) }))).toEqual(errorOf(413, "body_too_large"));
    }
    expect(service.connect).not.toHaveBeenCalled();
  });

  it("maps service errors to fixed bodies and logs unknown failures by name only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = app(fakeService({
      list: vi.fn(async () => { throw new BrainFeatureError("source_not_found"); }),
      update: vi.fn(async () => { throw new BrainStoreError("conflict"); }),
      remove: vi.fn(async () => { throw new BrainStoreError("not_found"); }),
      sync: vi.fn(async () => { throw new Error("secret detail /home/owner"); }),
    }));
    expect(await call(root, BASE)).toEqual(errorOf(404, "source_not_found"));
    expect(await call(root, `${BASE}/${SOURCE}`, json("PATCH", { expectedRevision: 1, label: "x" }))).toEqual(errorOf(409, "revision_conflict"));
    expect(await call(root, `${BASE}/${SOURCE}?expectedRevision=1`, { method: "DELETE" })).toEqual(errorOf(404, "source_not_found"));
    const failed = await call(root, `${BASE}/${SOURCE}/sync`, { method: "POST" });
    expect(failed).toEqual(errorOf(503, "brain_unavailable"));
    expect(JSON.stringify(failed.body)).not.toContain("secret");
    expect(error).toHaveBeenCalledWith("[brain-sources] Request failed:", "Error");
  });

  it("connects, lists, syncs, reads receipts, updates and removes a source end to end", async () => {
    const harness = await sourcesHarness();
    try {
      const service = createBrainSourcesService({
        repository: harness.repository, resolver: harness.resolver, handlers: [fakeHandler("linear")], runner: runBrainSourceSync,
      });
      const root = app(service);
      const created = await call(root, BASE, json("POST", { kind: "linear", config: { items: ["eng"] } }));
      expect(created).toMatchObject({ status: 201, body: { created: true, source: { kind: "linear", revision: 1 } } });
      const sourceId = (created.body as { source: { sourceId: string } }).source.sourceId;
      expect((await call(root, BASE, json("POST", { kind: "linear", config: { items: ["eng"] } }))).status).toBe(200);
      expect(await call(root, `${BASE}/${sourceId}/sync`, { method: "POST" })).toMatchObject({ status: 200, body: { status: "succeeded" } });
      expect(await call(root, `${BASE}/${sourceId}/receipts?limit=1`)).toMatchObject({ status: 200, body: { receipts: [{ status: "succeeded" }] } });
      const list = await call(root, "/api/brain/projects/alpha/sources");
      expect(list).toMatchObject({ status: 200, body: { items: [{ sourceId, lastSync: { status: "succeeded" } }] } });
      expect(await call(root, `${BASE}/${sourceId}`, json("PATCH", { expectedRevision: 1, label: "Engineering" })))
        .toMatchObject({ status: 200, body: { label: "Engineering", revision: 2 } });
      expect(await call(root, `${BASE}/${sourceId}?expectedRevision=1`, { method: "DELETE" })).toEqual(errorOf(409, "revision_conflict"));
      expect(await call(root, `${BASE}/${sourceId}?expectedRevision=2`, { method: "DELETE" })).toMatchObject({ status: 200 });
      expect(await call(root, `${BASE}/${sourceId}/receipts`)).toEqual(errorOf(404, "source_not_found"));
      expect(await call(root, `${BASE}/src_bad/sync`, { method: "POST" })).toEqual(errorOf(404, "source_not_found"));
      expect(await call(root, `${BASE}/src_bad`, json("PATCH", { expectedRevision: 1, label: "x" }))).toEqual(errorOf(404, "source_not_found"));
      expect(await call(root, `/api/brain/projects/proj_zz/sources/src_bad/sync`, { method: "POST" })).toEqual(errorOf(404, "project_not_found"));
      expect(await call(app(service, () => ({ userId: "owner_b", source: "dev-default" })), BASE)).toEqual(errorOf(404, "project_not_found"));
      expect(await call(root, BASE, json("POST", { kind: "linear", config: { items: ["BAD"] } }))).toEqual(errorOf(400, "source_config_invalid"));
    } finally {
      await harness.destroy();
    }
  });
});
