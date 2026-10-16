import { describe, expect, it, vi } from "vitest";
import {
  BRAIN_MODEL_RUN_TIMEOUT_MS, BRAIN_READ_TIMEOUT_MS, BRAIN_RUN_TIMEOUT_MS, brainJobsUnavailable, brainRouteMissing,
  brainRunMayContinue, type BrainHttpTransport,
} from "../../packages/ui/src/brain/brain-client.js";
import { brainShellError, createBrainShellApi, listBrainProjects } from "../../packages/ui/src/index.js";
import { apiError, PROJECT } from "./brain-fixtures.js";

/** A transport that records every call: method, path, body (for writes) and timeout. */
function fakeClient() {
  const calls: { method: string; path: string; body?: unknown; timeoutMs?: number }[] = [];
  const record = (method: string) => (path: string, ...rest: unknown[]) => {
    const options = rest[rest.length - 1] as { timeoutMs?: number };
    calls.push({ method, path, ...(rest.length === 2 ? { body: rest[0] } : {}), timeoutMs: options.timeoutMs });
    return Promise.resolve({ ok: true });
  };
  const client: BrainHttpTransport = {
    get: vi.fn(record("GET")) as BrainHttpTransport["get"], post: vi.fn(record("POST")) as BrainHttpTransport["post"],
    patch: vi.fn(record("PATCH")) as BrainHttpTransport["patch"],
    delete: vi.fn(record("DELETE")) as BrainHttpTransport["delete"],
  };
  return { client, calls };
}

/** An error shaped like the Electron Desktop one: a category set the view does not know is not read. */
class DesktopLikeError extends Error {
  constructor(readonly category: string, readonly detail?: string) {
    super("Request failed.");
    this.name = "AppError";
  }
}

const base = `/api/brain/projects/${PROJECT}`;

describe("createBrainShellApi", () => {
  it("maps every method to its route, query and timeout", async () => {
    const { client, calls } = fakeClient();
    const api = createBrainShellApi(client);
    const R = BRAIN_READ_TIMEOUT_MS;
    const W = BRAIN_RUN_TIMEOUT_MS;
    // [call, method, path under the project, timeout, body]
    const cases: [() => Promise<unknown>, string, string, number, unknown?][] = [
      [() => api.registerGitSource(PROJECT, {}), "POST", "/git-source", W, {}],
      [() => api.syncGit(PROJECT), "POST", "/sync", W, {}],
      [() => api.gitReceipts(PROJECT, 5), "GET", "/receipts?limit=5", R],
      [() => api.why(PROJECT, { path: "a b?.ts", limit: 2, cursor: null, detail: "full" }), "GET", "/why?path=a+b%3F.ts&limit=2&detail=full", R],
      [() => api.extract(PROJECT, { extractor: "rules" }), "POST", "/extract", W, { extractor: "rules" }],
      [() => api.extract(PROJECT, { extractor: "model" }), "POST", "/extract", BRAIN_MODEL_RUN_TIMEOUT_MS, { extractor: "model" }],
      [() => api.claims(PROJECT, { kind: "risk", path: "", limit: 50 }), "GET", "/claims?kind=risk&limit=50", R],
      [() => api.search(PROJECT, { q: "x", types: ["claim"], sourceId: "src_1", mode: "text", cursor: "c1" }), "GET",
        "/search?q=x&types=claim&source=src_1&mode=text&cursor=c1", R],
      [() => api.refreshSearch(PROJECT), "POST", "/search/refresh", W, {}],
      [() => api.timeline(PROJECT, { entity: "file:a.ts", linkTypes: ["authored"], limit: 20 }), "GET",
        "/timeline?entity=file%3Aa.ts&linkTypes=authored&limit=20", R],
      [() => api.entities(PROJECT, { kind: "person", q: "ann", limit: 10 }), "GET", "/entities?kind=person&q=ann&limit=10", R],
      [() => api.entity(PROJECT, "ent_1/2"), "GET", "/entities/ent_1%2F2", R],
      [() => api.entityLinks(PROJECT, "ent_1", { hops: 2, direction: "both" }), "GET", "/entities/ent_1/links?hops=2&direction=both", R],
      [() => api.updateAlias(PROJECT, "ent_1", { action: "merge", aliasKey: "person:name:ann" }), "POST", "/entities/ent_1/aliases", W,
        { action: "merge", aliasKey: "person:name:ann" }],
      [() => api.refreshGraph(PROJECT), "POST", "/graph/refresh", W, {}],
      [() => api.sources(PROJECT), "GET", "/sources", R],
      [() => api.connectSource(PROJECT, { kind: "linear", config: { teamKeys: ["ENG"] } }), "POST", "/sources", W,
        { kind: "linear", config: { teamKeys: ["ENG"] } }],
      [() => api.sourceOptions(PROJECT, "linear", { q: "en" }), "GET", "/sources/options?kind=linear&q=en", R],
      [() => api.updateSource(PROJECT, "src_1", { expectedRevision: 3, status: "paused" }), "PATCH", "/sources/src_1", R,
        { expectedRevision: 3, status: "paused" }],
      [() => api.removeSource(PROJECT, "src_1", 3), "DELETE", "/sources/src_1?expectedRevision=3", R],
      [() => api.syncSource(PROJECT, "src_1"), "POST", "/sources/src_1/sync", W, {}],
      [() => api.sourceReceipts(PROJECT, "src_1", 5), "GET", "/sources/src_1/receipts?limit=5", R],
      [() => api.brief(PROJECT, { window: "week" }), "GET", "/brief?window=week", W],
      [() => api.generateBrief(PROJECT, { window: "day" }), "POST", "/brief", W, { window: "day" }],
      [() => api.conflicts(PROJECT, { rules: ["label_disagreement"], limit: 50 }), "GET", "/conflicts?rules=label_disagreement&limit=50", R],
      [() => api.stale(PROJECT, { kinds: ["source_failing"] }), "GET", "/stale?kinds=source_failing", R],
      [() => api.stale(PROJECT, { kinds: [] }), "GET", "/stale", R],
      [() => api.impact(PROJECT, { head: "feature", depth: 1 }), "GET", "/impact?head=feature&depth=1", W],
      [() => api.mergeSuggestions(PROJECT, { limit: 10, cursor: "c" }), "GET", "/entities/merge-suggestions?limit=10&cursor=c", R],
      [() => api.startJob(PROJECT, { kind: "extract", extractor: "model" }), "POST", "/jobs", R,
        { kind: "extract", extractor: "model" }],
      [() => api.job(PROJECT, "job/1"), "GET", "/jobs/job%2F1", R],
      [() => api.jobs(PROJECT, 5), "GET", "/jobs?limit=5", R],
      [() => api.jobs(PROJECT), "GET", "/jobs", R],
      [() => api.cancelJob(PROJECT, "job_1"), "POST", "/jobs/job_1/cancel", R, {}],
    ];
    for (const [call] of cases) await call();
    expect(calls).toEqual(cases.map(([, method, path, timeoutMs, body]) => ({
      method, path: `${base}${path}`, ...(body === undefined ? {} : { body }), timeoutMs,
    })));
    // A model run may take its 120 s budget plus one 60 s call (spec 555).
    expect(BRAIN_MODEL_RUN_TIMEOUT_MS).toBeGreaterThan(180_000);
  });

  it("encodes the project reference", async () => {
    const { client, calls } = fakeClient();
    await createBrainShellApi(client).sources("a b");
    expect(calls[0]?.path).toBe("/api/brain/projects/a%20b/sources");
  });
});

describe("brainShellError", () => {
  it("maps categories and keeps only known codes", () => {
    expect(brainShellError(apiError("unauthorized"))).toEqual({ kind: "unauthorized" });
    expect(brainShellError(apiError("offline"))).toEqual({ kind: "offline" });
    expect(brainShellError(apiError("timeout"))).toEqual({ kind: "timeout" });
    expect(brainShellError(apiError("notFound", "entity_not_found"))).toEqual({ kind: "not_found", code: "entity_not_found" });
    expect(brainShellError(apiError("notFound"))).toEqual({ kind: "not_found", code: "unknown" });
    expect(brainShellError(apiError("notFound", "constructor"))).toEqual({ kind: "not_found", code: "unknown" });
    expect(brainShellError(apiError("server", "brain_unavailable"))).toEqual({ kind: "unavailable" });
    expect(brainShellError(apiError("server", "some_new_code"))).toEqual({ kind: "unavailable" });
    expect(brainShellError(apiError("server", "revision_conflict"))).toEqual({ kind: "rejected", code: "revision_conflict" });
  });

  it("tells a route this gateway does not serve from a known not-found code", () => {
    expect(brainRouteMissing(apiError("notFound"))).toBe(true);
    expect(brainRouteMissing(apiError("notFound", "not_found"))).toBe(true);
    expect(brainRouteMissing(apiError("notFound", "project_not_found"))).toBe(false);
    expect(brainRouteMissing(apiError("server"))).toBe(false);
    expect(brainRouteMissing(new Error("x"))).toBe(false);
    expect(brainJobsUnavailable(apiError("notFound"))).toBe(true);
    expect(brainJobsUnavailable(apiError("server", "job_kind_unavailable"))).toBe(true);
    expect(brainJobsUnavailable(apiError("server", "jobs_full"))).toBe(false);
    expect(brainJobsUnavailable(new Error("job_kind_unavailable"))).toBe(false);
  });

  it("reads any renderer's error by its shape and keeps only a code-like detail", () => {
    expect(brainShellError(new DesktopLikeError("notFound", "project_not_found")))
      .toEqual({ kind: "not_found", code: "project_not_found" });
    expect(brainShellError(new DesktopLikeError("server", "revision_conflict")))
      .toEqual({ kind: "rejected", code: "revision_conflict" });
    expect(brainShellError(new DesktopLikeError("server", "Revision Conflict!"))).toEqual({ kind: "unavailable" });
    expect(brainShellError(new DesktopLikeError("notFound", "x".repeat(60))))
      .toEqual({ kind: "not_found", code: "unknown" });
    expect(brainRunMayContinue(new DesktopLikeError("timeout"))).toBe(true);
    expect(brainRunMayContinue(apiError("server"))).toBe(true);
    expect(brainRunMayContinue(apiError("server", "brain_unavailable"))).toBe(false);
    expect(brainRunMayContinue(apiError("offline"))).toBe(false);
    expect(brainRunMayContinue(new Error("timeout"))).toBe(false);
  });

  it("treats anything else as unavailable and logs only its name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(brainShellError(new TypeError("secret detail"))).toEqual({ kind: "unavailable" });
    expect(brainShellError("text")).toEqual({ kind: "unavailable" });
    // A category the view does not know (an Electron Desktop one the adapter did not map) is not read either.
    expect(brainShellError(new DesktopLikeError("misconfigured", "project_not_found")))
      .toEqual({ kind: "unavailable" });
    expect(brainShellError({ category: "notFound", detail: "project_not_found" })).toEqual({ kind: "unavailable" });
    expect(warn.mock.calls.map(([, name]) => name)).toEqual(["TypeError", "string", "AppError", "object"]);
    expect(warn.mock.calls.every(([text]) => text === "[brain] request failed")).toBe(true);
    warn.mockRestore();
  });
});

describe("listBrainProjects", () => {
  const client = (value: unknown) => ({ get: vi.fn(async () => value) } as unknown as BrainHttpTransport);

  it("keeps well-formed projects and falls back to the slug for a name", async () => {
    const projects = await listBrainProjects(client({
      projects: [
        { id: PROJECT, name: "  matrix-os  ", slug: "matrix-os" },
        { id: "proj_2", name: "", slug: "second" },
        { id: "proj_3", slug: "third" },
        { id: "bad id", name: "x", slug: "x" },
        { id: "proj_4", name: "no slug" },
        { id: 5, slug: "five" },
        null,
        "text",
      ],
    }));
    expect(projects).toEqual([
      { id: PROJECT, name: "matrix-os", slug: "matrix-os" },
      { id: "proj_2", name: "second", slug: "second" },
      { id: "proj_3", name: "third", slug: "third" },
    ]);
  });

  it("reads the first page of projects with the read timeout", async () => {
    const get = vi.fn(async () => ({ projects: [] }));
    await listBrainProjects({ get } as unknown as BrainHttpTransport);
    expect(get).toHaveBeenCalledWith("/api/workspace/projects", { timeoutMs: BRAIN_READ_TIMEOUT_MS });
  });

  it("answers an empty list for a malformed body and caps long lists", async () => {
    expect(await listBrainProjects(client(null))).toEqual([]);
    expect(await listBrainProjects(client({ projects: "x" }))).toEqual([]);
    const many = Array.from({ length: 250 }, (_, index) => ({ id: `proj_${index}`, name: "n", slug: `s${index}` }));
    expect(await listBrainProjects(client({ projects: many }))).toHaveLength(200);
  });
});
