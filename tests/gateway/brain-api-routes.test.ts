/**
 * /api/brain routes over a mocked BrainProjectService. Every response is checked
 * for `Cache-Control: private, no-store` and for text that must never leave the gateway.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { createBrainRoutes } from "../../packages/gateway/src/brain/api/routes.js";
import {
  BRAIN_API_ERRORS, BRAIN_STORE_ERROR_API_CODES, BrainApiError, brainApiErrorBody,
  type BrainApiErrorCode, type BrainGitSourceView, type BrainProjectService, type BrainReceiptView,
  type BrainSyncView, type BrainWhyResult,
} from "../../packages/gateway/src/brain/api/types.js";
import { BrainStoreError, type BrainStoreErrorCode } from "../../packages/gateway/src/brain/index.js";
import {
  MissingRequestPrincipalError, RequestPrincipalMisconfiguredError, type RequestPrincipal,
} from "../../packages/gateway/src/request-principal.js";

const BASE = "/api/brain/projects/proj_widgets";
const OWNER: RequestPrincipal = { userId: "owner_a", source: "dev-default" };
const LEAK = /postgres|stack|\/home\/|stderr/i;
const AT = "2026-10-01T10:00:00.000Z";

const SOURCE: BrainGitSourceView = {
  sourceId: "a".repeat(64), label: "Widgets", externalRef: "project:proj_widgets", webBase: null,
  status: "active", createdAt: AT, updatedAt: AT,
};
const RECEIPT: BrainReceiptView = {
  receiptId: "b".repeat(64), status: "succeeded", counts: { read: 2, written: 2, unchanged: 0, deleted: 0, failed: 0 },
  nextAction: "run_again", errorCode: null, startedAt: AT, finishedAt: AT,
};
const SYNC: BrainSyncView = {
  status: "succeeded", errorCode: null, nextAction: "run_again", caughtUp: false, commitsProcessed: 500,
  commitsRemaining: 12, counts: RECEIPT.counts, notices: ["message_truncated"], receipt: RECEIPT,
};
const WHY: BrainWhyResult = {
  path: "src", match: "folder", detail: "brief", total: 1, totalCapped: false, nextCursor: null,
  items: [{
    documentId: "c".repeat(64), kind: "pr", label: "#1", number: 1, sha: "d".repeat(40), title: "feat: alpha",
    date: AT, permalink: "https://github.com/acme/widgets/pull/1", link: "inferred",
    summary: { heading: "Summary", text: "- Adds alpha.", truncated: false }, invariants: null,
    specs: ["specs/001-alpha"], matchedPaths: ["src/alpha.ts"], matchedPathCount: 1,
  }],
  source: { sourceId: SOURCE.sourceId, webBase: null, lastSync: { ...RECEIPT, status: "succeeded" } },
};

type ServiceMock = { [K in keyof BrainProjectService]: Mock<BrainProjectService[K]> };

const serviceMock = (): ServiceMock => ({
  registerGitSource: vi.fn<BrainProjectService["registerGitSource"]>(async () => ({ source: SOURCE, created: true })),
  sync: vi.fn<BrainProjectService["sync"]>(async () => SYNC),
  listReceipts: vi.fn<BrainProjectService["listReceipts"]>(async () => ({ source: SOURCE, receipts: [RECEIPT] })),
  why: vi.fn<BrainProjectService["why"]>(async () => WHY),
  extract: vi.fn<BrainProjectService["extract"]>(), listClaims: vi.fn<BrainProjectService["listClaims"]>(),
});

function setup(options: { service?: null; getPrincipal?: () => RequestPrincipal } = {}) {
  const service = serviceMock();
  const app = new Hono();
  app.route("/api/brain", createBrainRoutes({
    service: options.service === null ? null : service,
    getPrincipal: options.getPrincipal ?? (() => OWNER),
  }));
  const calls = () => Object.values(service).reduce((n, fn) => n + fn.mock.calls.length, 0);
  return { app, service, calls };
}

function post(path: string, body?: string, headers: Record<string, string> = { "Content-Type": "application/json" }) {
  return new Request(`http://localhost${path}`, { method: "POST", ...(body === undefined ? {} : { body, headers }) });
}

/** Every response: no-store, and nothing internal in the text. */
async function call(app: Hono, request: Request | string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(request);
  const text = await res.text();
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(text).not.toMatch(LEAK);
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

/** The fixed error response of a code. */
const failure = (code: BrainApiErrorCode) => ({ status: BRAIN_API_ERRORS[code].status, body: brainApiErrorBody(code) });
const EMPTY_JSON = { "Content-Type": "application/json", "Content-Length": "0" };

type RouteCase = { name: string; request: (base: string) => Request | string; method: keyof BrainProjectService };
const ROUTES: readonly RouteCase[] = [
  { name: "git-source", request: (base) => post(`${base}/git-source`), method: "registerGitSource" },
  { name: "sync", request: (base) => post(`${base}/sync`), method: "sync" },
  { name: "receipts", request: (base) => `${base}/receipts`, method: "listReceipts" },
  { name: "why", request: (base) => `${base}/why?path=src/alpha.ts`, method: "why" },
];

describe("brain api routes", () => {
  let errorLog: MockInstance<typeof console.error>;
  beforeEach(() => { errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => { errorLog.mockRestore(); });

  it("registers a git source: 201 when created, 200 when it already existed", async () => {
    const { app, service } = setup();
    expect(await call(app, post(`${BASE}/git-source`)))
      .toEqual({ status: 201, body: { source: SOURCE, created: true } });
    expect(service.registerGitSource).toHaveBeenLastCalledWith("owner_a", "proj_widgets", {});

    service.registerGitSource.mockResolvedValueOnce({ source: SOURCE, created: false });
    const webBase = "https://github.com/acme/widgets";
    expect(await call(app, post(`${BASE}/git-source`, JSON.stringify({ webBase }))))
      .toEqual({ status: 200, body: { source: SOURCE, created: false } });
    expect(service.registerGitSource).toHaveBeenLastCalledWith("owner_a", "proj_widgets", { webBase });
    expect(await call(app, post(`${BASE}/git-source`, "", EMPTY_JSON))).toMatchObject({ status: 201 });
  });

  it("runs a sync and returns the view unchanged; absent, empty and {} bodies are accepted", async () => {
    const { app, service } = setup();
    for (const request of [post(`${BASE}/sync`), post(`${BASE}/sync`, "{}"), post(`${BASE}/sync`, "", EMPTY_JSON)]) {
      expect(await call(app, request)).toEqual({ status: 200, body: SYNC });
    }
    expect(service.sync.mock.calls).toEqual(Array.from({ length: 3 }, () => ["owner_a", "proj_widgets"]));
  });

  it("lists receipts with the default and an explicit limit, for the principal's user", async () => {
    const { app, service } = setup();
    expect(await call(app, `${BASE}/receipts`)).toEqual({ status: 200, body: { source: SOURCE, receipts: [RECEIPT] } });
    await call(app, `${BASE}/receipts?limit=50`);
    expect(service.listReceipts.mock.calls).toEqual([["owner_a", "proj_widgets", 10], ["owner_a", "proj_widgets", 50]]);

    const other = setup({ getPrincipal: () => ({ userId: "owner_z", source: "jwt" }) });
    await call(other.app, `${BASE}/receipts`);
    expect(other.service.listReceipts).toHaveBeenCalledWith("owner_z", "proj_widgets", 10);
  });

  it("answers why with defaults, forwards a folder path unchanged, and passes limit, cursor and detail", async () => {
    const { app, service } = setup();
    expect(await call(app, `${BASE}/why?path=src/`)).toEqual({ status: 200, body: WHY });
    const [owner, project, query] = service.why.mock.calls[0]!;
    expect([owner, project, query.path, query.limit, query.detail, query.cursor ?? null])
      .toEqual(["owner_a", "proj_widgets", "src/", 10, "brief", null]);

    const path = "docs/caf\u00e9/na\u00efve file #1?.md";
    await call(app, `${BASE}/why?path=${encodeURIComponent(path)}&limit=50&cursor=abc_-&detail=full`);
    expect(service.why)
      .toHaveBeenLastCalledWith("owner_a", "proj_widgets", { path, limit: 50, cursor: "abc_-", detail: "full" });
  });

  it.each(ROUTES)("$name: 401 without a principal, 500 when its context is misconfigured", async ({ request }) => {
    const missing = setup({ getPrincipal: () => { throw new MissingRequestPrincipalError(); } });
    expect(await call(missing.app, request(BASE))).toEqual({ status: 401, body: { error: "Unauthorized" } });
    expect(missing.calls()).toBe(0);

    const broken = setup({ getPrincipal: () => { throw new RequestPrincipalMisconfiguredError(); } });
    expect(await call(broken.app, request(BASE)))
      .toEqual({ status: 500, body: { error: "Company brain request failed" } });
    expect(broken.calls()).toBe(0);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("not initialized");
  });

  it.each(ROUTES)("$name: 503 when the brain store is not configured", async ({ request }) => {
    expect(await call(setup({ service: null }).app, request(BASE))).toEqual(failure("brain_unavailable"));
  });

  it.each(ROUTES)("$name: a malformed project ref reads exactly like a missing project", async ({ request, method }) => {
    const { app, service, calls } = setup();
    for (const ref of ["Widgets", "proj_", "proj_a.b", "-widgets", `proj_${"x".repeat(129)}`, "w".repeat(64)]) {
      expect(await call(app, request(`/api/brain/projects/${ref}`)), ref).toEqual(failure("project_not_found"));
    }
    expect(await call(app, "/api/brain/projects/Widgets/why?bogus=1")).toEqual(failure("project_not_found"));
    expect(calls()).toBe(0);
    service[method].mockRejectedValueOnce(new BrainApiError("project_not_found"));
    expect(await call(app, request(BASE))).toEqual(failure("project_not_found"));
  });

  it.each(ROUTES)("$name: takes a project slug as well as an id", async ({ request, method }) => {
    const { app, service } = setup();
    expect((await call(app, request("/api/brain/projects/widgets-2"))).status).toBeLessThan(300);
    expect(service[method].mock.calls[0]?.slice(0, 2)).toEqual(["owner_a", "widgets-2"]);
  });

  it("registers no middleware that reaches other routers mounted under /api/brain", async () => {
    const { app } = setup();
    app.get("/api/brain/other", (c) => c.text("other"));
    expect((await app.request("/api/brain/other")).headers.get("cache-control")).toBeNull();
  });

  it.each([
    ["unknown key", "why?path=src&bogus=1"], ["duplicate key", "why?path=src&path=lib"], ["no path", "why?limit=5"],
    ["empty path", "why?path="], ["absolute path", "why?path=%2Fabs"], ["dot-dot segment", "why?path=a%2F..%2Fb"],
    ["double slash", "why?path=a%2F%2F"], ["root", "why?path=%2F"], ["path over 1024", `why?path=${"a".repeat(1025)}`],
    ["limit 0", "why?path=src&limit=0"], ["limit 51", "why?path=src&limit=51"], ["limit 1.5", "why?path=src&limit=1.5"],
    ["detail x", "why?path=src&detail=x"], ["empty cursor", "why?path=src&cursor="],
    ["cursor over 256", `why?path=src&cursor=${"c".repeat(257)}`], ["receipts limit 0", "receipts?limit=0"],
    ["receipts limit 51", "receipts?limit=51"], ["receipts limit abc", "receipts?limit=abc"],
    ["receipts unknown key", "receipts?cursor=x"], ["receipts duplicate key", "receipts?limit=1&limit=2"],
  ])("400 for %s", async (_label, query) => {
    const { app, calls } = setup();
    expect(await call(app, `${BASE}/${query}`)).toEqual(failure("invalid_request"));
    expect(calls()).toBe(0);
  });

  it.each([
    ["git-source", "unknown field", JSON.stringify({ webBase: "https://github.com/acme/widgets", extra: 1 })],
    ["git-source", "invalid JSON", "{\"webBase\":"], ["git-source", "array body", "[]"],
    ["git-source", "webBase over 512", JSON.stringify({ webBase: `https://x.dev/${"a".repeat(500)}` })],
    ["git-source", "empty webBase", JSON.stringify({ webBase: "" })],
    ["git-source", "webBase not a string", JSON.stringify({ webBase: 1 })],
    ["sync", "unknown field", JSON.stringify({ force: true })], ["sync", "invalid JSON", "{"],
    ["sync", "null body", "null"],
  ])("%s: 400 for %s", async (route, _label, body) => {
    const { app, calls } = setup();
    expect(await call(app, post(`${BASE}/${route}`, body))).toEqual(failure("invalid_request"));
    expect(calls()).toBe(0);
  });

  it.each([["git-source", 5 * 1024], ["sync", 2 * 1024]])("%s: 413 for a %i byte body", async (route, size) => {
    const { app, calls } = setup();
    const body = JSON.stringify({ webBase: "x".repeat(size) });
    const headers = { "Content-Type": "application/json", "Content-Length": String(body.length) };
    expect(await call(app, post(`${BASE}/${route}`, body))).toEqual(failure("body_too_large"));
    expect(await call(app, post(`${BASE}/${route}`, body, headers))).toEqual(failure("body_too_large"));
    expect(calls()).toBe(0);
  });

  const apiCodes = Object.keys(BRAIN_API_ERRORS) as BrainApiErrorCode[];
  it.each(apiCodes)("maps BrainApiError %s on every route", async (code) => {
    const { app, service } = setup();
    for (const { request, method } of ROUTES) {
      service[method].mockRejectedValueOnce(new BrainApiError(code, { cause: new Error("postgres at /home/x") }));
      expect(await call(app, request(BASE)), method).toEqual(failure(code));
    }
  });

  const storeCodes = Object.keys(BRAIN_STORE_ERROR_API_CODES) as BrainStoreErrorCode[];
  it.each(storeCodes)("maps BrainStoreError %s", async (code) => {
    const { app, service } = setup();
    service.why.mockRejectedValueOnce(new BrainStoreError(code));
    expect(await call(app, `${BASE}/why?path=src&cursor=stale`)).toEqual(failure(BRAIN_STORE_ERROR_API_CODES[code]));
  });

  it("turns an unknown error into 503 and logs only its name", async () => {
    const { app, service } = setup();
    const secret = "postgres://user@db failed at /home/matrix/projects stack stderr";
    service.sync.mockRejectedValueOnce(new TypeError(secret));
    expect(await call(app, post(`${BASE}/sync`))).toEqual(failure("brain_unavailable"));
    expect(errorLog).toHaveBeenCalledWith("[brain-api] Request failed:", "TypeError");
    service.why.mockRejectedValueOnce("boom");
    expect(await call(app, `${BASE}/why?path=src`)).toEqual(failure("brain_unavailable"));
    expect(errorLog).toHaveBeenLastCalledWith("[brain-api] Request failed:", "UnknownError");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
  });
});
