/**
 * Impact routes over a mocked service: query validation and Cache-Control on every response (the shared guard and
 * error mapping are tested in brain-feature-route-kit.test.ts).
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrainImpactService, BrainImpactView } from "../../packages/gateway/src/brain/contracts.js";
import { createBrainImpactRoutes } from "../../packages/gateway/src/brain/impact/index.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const OWNER: RequestPrincipal = { userId: "owner_a", source: "dev-default" };
const BASE = "/api/brain/projects/proj_widgets/impact";
const VIEW = { approximate: true, notices: [] } as unknown as BrainImpactView;

function setup(options: { service?: null } = {}) {
  const service = {
    impact: vi.fn<BrainImpactService["impact"]>(async () => VIEW),
    comment: vi.fn<BrainImpactService["comment"]>(async () => ({ markdown: "# x", truncated: false })),
  };
  const app = new Hono();
  app.route("/api/brain", createBrainImpactRoutes({
    service: options.service === null ? null : service, getPrincipal: () => OWNER,
  }));
  return { app, service };
}

async function call(app: Hono, path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`http://localhost${path}`);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  return { status: res.status, body: await res.json() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("impact routes", () => {
  it("answers the brief and the comment for a project id or slug", async () => {
    const { app, service } = setup();
    expect(await call(app, `${BASE}?head=feature&base=main&depth=2`)).toEqual({ status: 200, body: VIEW });
    expect(service.impact).toHaveBeenCalledWith("owner_a", "proj_widgets", { head: "feature", base: "main", depth: 2 });
    expect((await call(app, "/api/brain/projects/widgets/impact/comment?head=abc1234&depth=1")).body)
      .toEqual({ markdown: "# x", truncated: false });
    expect(service.comment).toHaveBeenCalledWith("owner_a", "widgets", { head: "abc1234", depth: 1 });
  });

  it("checks principal, availability, project ref and query first", async () => {
    const { app, service } = setup();
    for (const query of ["", "?head=HEAD", "?head=a&depth=3", "?head=a&other=1", "?head=a&head=b", "?head=a&base=..x"]) {
      expect(await call(app, `${BASE}${query}`)).toEqual({
        status: 400, body: { error: { code: "invalid_request", message: "Invalid brain request" } },
      });
    }
    expect((await call(app, "/api/brain/projects/Bad!/impact?head=a")).status).toBe(404);
    expect(service.impact).not.toHaveBeenCalled();
    expect((await call(setup({ service: null }).app, `${BASE}?head=a`)).status).toBe(503);
  });

});
