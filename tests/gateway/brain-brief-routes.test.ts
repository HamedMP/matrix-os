import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrainBriefRoutes } from "../../packages/gateway/src/brain/brief/index.js";
import type { BrainBriefService } from "../../packages/gateway/src/brain/contracts.js";
import { BRIEF_OWNER, createBriefFixture } from "./helpers/brain-brief-fixture.js";

const okPage = { items: [], nextCursor: null };

function fakeService(overrides: Partial<BrainBriefService> = {}): BrainBriefService {
  return {
    getBrief: vi.fn(async () => ({ date: "2026-10-01" }) as never),
    generateBrief: vi.fn(async () => ({ date: "2026-10-01" }) as never),
    conflicts: vi.fn(async () => okPage),
    stale: vi.fn(async () => okPage),
    ...overrides,
  };
}

function app(service: BrainBriefService | null, principal: () => unknown = () => ({ userId: BRIEF_OWNER, source: "dev-default" })) {
  const root = new Hono();
  root.route("/api/brain", createBrainBriefRoutes({ service, getPrincipal: principal as never }));
  return root;
}

const call = async (root: Hono, path: string, init?: RequestInit) => {
  const response = await root.request(`/api/brain/projects/${path}`, init);
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
};
const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  ({ method: "POST", body, headers });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("brief routes", () => {
  it("passes parsed queries and bodies to the service", async () => {
    const service = fakeService();
    const root = app(service);
    expect(await call(root, "alpha/brief?date=2026-10-01&window=week")).toMatchObject({ status: 200, cache: "private, no-store" });
    expect(service.getBrief).toHaveBeenCalledWith(BRIEF_OWNER, "alpha", { date: "2026-10-01", window: "week" });
    expect((await call(root, "proj_a/brief", post("{\"summary\":true}"))).status).toBe(200);
    expect(service.generateBrief).toHaveBeenCalledWith(BRIEF_OWNER, "proj_a", { summary: true });
    expect((await call(root, "proj_a/brief", { method: "POST" })).status).toBe(200);
    expect(service.generateBrief).toHaveBeenLastCalledWith(BRIEF_OWNER, "proj_a", {});
    await call(root, "proj_a/conflicts?rules=label_disagreement,draft_spec_shipped&limit=5&cursor=abc");
    expect(service.conflicts).toHaveBeenCalledWith(BRIEF_OWNER, "proj_a",
      { rules: ["label_disagreement", "draft_spec_shipped"], limit: 5, cursor: "abc" });
    await call(root, "proj_a/stale?kinds=claim_outdated");
    expect(service.stale).toHaveBeenCalledWith(BRIEF_OWNER, "proj_a", { kinds: ["claim_outdated"], limit: 20 });
  });

  it("rejects bad input with generic codes", async () => {
    const root = app(fakeService());
    const bad = ["proj_a/brief?date=10-01", "proj_a/brief?x=1", "proj_a/brief?window=day&window=week",
      "proj_a/conflicts?rules=nope", "proj_a/conflicts?limit=51", "proj_a/stale?kinds=", "proj_a/stale?cursor="];
    for (const path of bad) {
      expect(await call(root, path)).toMatchObject({ status: 400, body: { error: { code: "invalid_request", message: "Invalid brain request" } } });
    }
    for (const init of [post("{"), post("{\"extra\":1}"), post("[]"), { ...post("{}"), method: "POST" }]) {
      const path = init.body === "{}" ? "proj_a/brief?x=1" : "proj_a/brief";
      expect((await call(root, path, init)).status).toBe(400);
    }
    const big = await call(root, "proj_a/brief", post(JSON.stringify({ date: "x".repeat(2_000) })));
    expect(big).toMatchObject({ status: 413, body: { error: { code: "body_too_large" } }, cache: "private, no-store" });
    const declared = await call(root, "proj_a/brief", post("{}", { "content-type": "application/json", "content-length": "5000" }));
    expect(declared).toMatchObject({ status: 413, body: { error: { code: "body_too_large" } } });
    expect(await call(root, "Not A Project/brief")).toMatchObject({ status: 404, body: { error: { code: "project_not_found" } } });
  });

  it("serves a real brief end to end", async () => {
    const fx = await createBriefFixture();
    try {
      const root = app(fx.feature.service);
      const brief = await call(root, "proj_a/brief");
      expect(brief).toMatchObject({ status: 200, body: { date: "2026-10-01", stored: true, sections: { attention: [] } } });
      expect(await call(root, "proj_a/brief", post("{\"summary\":true}"))).toMatchObject({ status: 409,
        body: { error: { code: "summary_not_configured", message: "Brief summaries are turned off" } } });
      expect(await call(root, "proj_zz/conflicts")).toMatchObject({ status: 404 });
      expect(await call(root, "proj_a/conflicts?cursor=zz")).toMatchObject({ status: 400 });
    } finally {
      await fx.destroy();
    }
  });
});
