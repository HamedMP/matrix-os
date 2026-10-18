import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainApiError } from "../../packages/gateway/src/brain/api/types.js";
import {
  BrainJobError, createBrainJobsRoutes, type BrainJobsService, type BrainJobView,
} from "../../packages/gateway/src/brain/jobs/index.js";

const OWNER = "owner_routes";
const JOB = `job_${"a".repeat(32)}`;
const view = { jobId: JOB, status: "queued" } as unknown as BrainJobView;

function fakeService(overrides: Partial<BrainJobsService> = {}): BrainJobsService {
  return {
    enqueue: vi.fn(async () => ({ job: view, deduped: false })),
    get: vi.fn(async () => view),
    list: vi.fn(async () => ({ jobs: [view] })),
    cancel: vi.fn(async () => view),
    ...overrides,
  };
}

function app(service: BrainJobsService | null) {
  const root = new Hono();
  root.route("/api/brain", createBrainJobsRoutes({
    service, getPrincipal: (() => ({ userId: OWNER, source: "dev-default" })) as never,
  }));
  return root;
}

const call = async (root: Hono, path: string, init?: RequestInit) => {
  const response = await root.request(`/api/brain/projects/${path}`, init);
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
};
const post = (body?: string) => ({
  method: "POST", ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("brain job routes", () => {
  it("queues, reads, lists and cancels runs", async () => {
    const service = fakeService();
    const root = app(service);
    expect(await call(root, "proj_a/jobs", post("{\"kind\":\"sync\"}")))
      .toEqual({ status: 202, body: { job: view, deduped: false }, cache: "private, no-store" });
    expect(service.enqueue).toHaveBeenCalledWith(OWNER, "proj_a", { kind: "sync" });
    await call(root, "alpha/jobs", post("{\"kind\":\"extract\"}"));
    expect(service.enqueue).toHaveBeenLastCalledWith(OWNER, "alpha", { kind: "extract", extractor: "rules" });
    await call(root, "alpha/jobs", post(`{"kind":"sync","sourceId":"src_${"b".repeat(32)}"}`));
    expect(service.enqueue).toHaveBeenLastCalledWith(OWNER, "alpha", { kind: "sync", sourceId: `src_${"b".repeat(32)}` });
    expect(await call(root, `proj_a/jobs/${JOB}`)).toMatchObject({ status: 200, body: view });
    expect(service.get).toHaveBeenCalledWith(OWNER, "proj_a", JOB);
    expect(await call(root, "proj_a/jobs")).toMatchObject({ status: 200, body: { jobs: [view] } });
    expect(service.list).toHaveBeenCalledWith(OWNER, "proj_a", 20);
    await call(root, "proj_a/jobs?limit=50");
    expect(service.list).toHaveBeenLastCalledWith(OWNER, "proj_a", 50);
    expect(await call(root, `proj_a/jobs/${JOB}/cancel`, post())).toMatchObject({ status: 200, body: view });
    expect(await call(root, `proj_a/jobs/${JOB}/cancel`, post("{}"))).toMatchObject({ status: 200 });
    expect(service.cancel).toHaveBeenCalledWith(OWNER, "proj_a", JOB);
  });

  it("rejects bad input with generic codes", async () => {
    const service = fakeService();
    const root = app(service);
    const invalid = { status: 400, body: { error: { code: "invalid_request", message: "Invalid brain request" } } };
    for (const body of ["{", "{}", "{\"kind\":\"nope\"}", "{\"kind\":\"sync\",\"x\":1}", "{\"kind\":\"sync\",\"sourceId\":\"src_x\"}",
      "{\"kind\":\"brief\",\"window\":\"month\"}", "[]"]) {
      expect(await call(root, "proj_a/jobs", post(body))).toMatchObject(invalid);
    }
    expect(await call(root, "proj_a/jobs", post())).toMatchObject(invalid);
    expect(await call(root, "proj_a/jobs?x=1", post("{\"kind\":\"sync\"}"))).toMatchObject(invalid);
    for (const path of ["proj_a/jobs?limit=0", "proj_a/jobs?limit=51", "proj_a/jobs?limit=1&limit=2", `proj_a/jobs/${JOB}?x=1`]) {
      expect(await call(root, path)).toMatchObject(invalid);
    }
    expect(await call(root, `proj_a/jobs/${JOB}/cancel`, post("{\"x\":1}"))).toMatchObject(invalid);
    const big = await call(root, "proj_a/jobs", post(`{"kind":"sync","pad":"${"x".repeat(2_000)}"}`));
    expect(big).toMatchObject({ status: 413, body: { error: { code: "body_too_large" } } });
    const notFound = { status: 404, body: { error: { code: "job_not_found", message: "Run not found" } } };
    expect(await call(root, "proj_a/jobs/job_short")).toMatchObject(notFound);
    expect(await call(root, "proj_a/jobs/job_short/cancel", post())).toMatchObject(notFound);
    expect(await call(root, "Bad%20Ref/jobs")).toMatchObject({ status: 404, body: { error: { code: "project_not_found" } } });
    expect(service.enqueue).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it("maps job, API and unknown errors and answers 503 while off", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = app(fakeService({
      enqueue: vi.fn(async () => { throw new BrainJobError("jobs_full"); }),
      get: vi.fn(async () => { throw new BrainJobError("job_not_found"); }),
      list: vi.fn(async () => { throw new BrainApiError("project_not_found"); }),
      cancel: vi.fn(async () => { throw new RangeError("db"); }),
    }));
    expect(await call(root, "proj_a/jobs", post("{\"kind\":\"graph_refresh\"}"))).toEqual({
      status: 409, cache: "private, no-store",
      body: { error: { code: "jobs_full", message: "Too many runs are waiting; try again later" } },
    });
    expect(await call(root, `proj_a/jobs/${JOB}`)).toMatchObject({ status: 404, body: { error: { code: "job_not_found" } } });
    expect(await call(root, "proj_a/jobs")).toMatchObject({ status: 404, body: { error: { code: "project_not_found" } } });
    expect(await call(root, `proj_a/jobs/${JOB}/cancel`, post())).toMatchObject({
      status: 503, body: { error: { code: "brain_unavailable" } },
    });
    expect(error).toHaveBeenCalledWith("[brain-jobs] Request failed:", "RangeError");
    expect(await call(app(null), "proj_a/jobs")).toMatchObject({ status: 503, body: { error: { code: "brain_unavailable" } } });
  });
});
