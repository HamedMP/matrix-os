import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const state = vi.hoisted(() => ({ rows: [] as Record<string, any>[] }));
vi.mock("../../../packages/gateway/src/app-store/private-state.js", () => ({
  sweepPrivateChildren: vi.fn(async () => 0),
  atomicPrivateFile: vi.fn(),
  withStoreDirectory: async (
    _home: string,
    segments: string[],
    operation: (dir: unknown) => unknown,
  ) => {
    expect(segments).toEqual(["install-jobs"]);
    return operation({
      entries: async () =>
        state.rows.map((row) => ({
          name: row.job.id,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })),
      child: async (id: string) => ({
        readFile: async () =>
          Buffer.from(
            JSON.stringify(state.rows.find((row) => row.job.id === id)),
          ),
        close: async () => {},
      }),
    });
  },
}));
vi.mock("../../../packages/gateway/src/app-store/provenance.js", () => ({
  readStoreProvenance: async () => ({ version: 1, installs: [] }),
  installedAppPresent: vi.fn(),
}));
import { createStoreInstallService } from "../../../packages/gateway/src/app-store/install-service.js";
import { registerAppStoreRoutes } from "../../../packages/gateway/src/app-store/routes.js";
const versionId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
let service: ReturnType<typeof createStoreInstallService>;
const platform = {
  detail: vi.fn(async () => ({
    slug: "notes",
    currentVersion: { id: versionId, version: "1.0.0" },
  })),
  download: vi.fn(),
};
const builder = { build: vi.fn(), close: vi.fn() };
function record(status: string, overrides: Record<string, unknown> = {}) {
  return {
    job: { id: jobId, status },
    listingSlug: "notes",
    versionId,
    consentDigest: "a".repeat(64),
    updatedAt: 1,
    receiptPending: false,
    ...overrides,
  };
}
beforeEach(() => {
  state.rows = [];
  vi.clearAllMocks();
  service = createStoreInstallService({
    homePath: "/owner",
    platform: platform as any,
    builder,
  });
});
afterEach(async () => {
  await service.close();
});
describe("durable listing build recovery", () => {
  it("loads an active job from private records without new downloads or builds", async () => {
    state.rows = [record("building")];
    expect((await service.detail("notes")).installJob).toEqual({
      id: jobId,
      status: "building",
    });
    expect(platform.download).not.toHaveBeenCalled();
    expect(builder.build).not.toHaveBeenCalled();
  });
  it("prefers a current active build over an older terminal record", async () => {
    state.rows = [
      record("installed", {
        job: { id: otherId, status: "installed" },
        updatedAt: 100,
      }),
      record("queued"),
    ];
    expect((await service.detail("notes")).installJob).toEqual({
      id: jobId,
      status: "queued",
    });
  });
  it("returns the latest terminal failure when the build finished while Gallery was closed", async () => {
    state.rows = [
      record("installed"),
      record("failed", {
        job: { id: otherId, status: "failed", error: "build_failed" },
        updatedAt: 2,
      }),
    ];
    expect((await service.detail("notes")).installJob).toEqual({
      id: otherId,
      status: "failed",
      error: "build_failed",
    });
  });
  it("excludes another listing and old-version jobs", async () => {
    state.rows = [
      record("building", { listingSlug: "other" }),
      record("building", {
        job: { id: otherId, status: "building" },
        versionId: otherId,
      }),
    ];
    expect((await service.detail("notes")).installJob).toBeNull();
  });
  it("keeps the bounded private record cap for listing reads", async () => {
    state.rows = Array.from({ length: 33 }, () => record("building"));
    await expect(service.detail("notes")).rejects.toMatchObject({
      code: "limit",
    });
  });
  it("only exposes recovery to the authenticated owner through the existing detail route", async () => {
    state.rows = [record("building")];
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("authContextReady" as never, true as never);
      if (c.req.header("x-test-user"))
        c.set("platformUserId" as never, c.req.header("x-test-user") as never);
      await next();
    });
    registerAppStoreRoutes(app, {
      homePath: "/owner",
      ownerIds: ["owner"],
      install: service,
    });
    expect((await app.request("/api/app-store/listings/notes")).status).toBe(
      401,
    );
    expect(
      (
        await app.request("/api/app-store/listings/notes", {
          headers: { "x-test-user": "other" },
        })
      ).status,
    ).toBe(403);
    const response = await app.request("/api/app-store/listings/notes", {
      headers: { "x-test-user": "owner" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      installJob: { id: jobId, status: "building" },
    });
    expect(
      JSON.stringify(
        await (
          await app.request("/api/app-store/listings/notes", {
            headers: { "x-test-user": "owner" },
          })
        ).json(),
      ),
    ).not.toContain("consentDigest");
  });
});
