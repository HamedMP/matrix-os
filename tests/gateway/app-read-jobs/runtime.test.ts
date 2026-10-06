import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createAppReadJobRuntime } from "../../../packages/gateway/src/app-read-jobs/runtime.js";
const mocks = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(async () => {}),
  status: vi.fn(async () => null), run: vi.fn(async () => ({ status: "accepted" })), pause: vi.fn(async () => null),
  runner: vi.fn(), store: vi.fn(),
}));
vi.mock("../../../packages/gateway/src/app-read-jobs/runner.js", () => ({
  createAppReadJobRunner: mocks.runner.mockImplementation(() => ({ start: mocks.start, stop: mocks.stop, status: mocks.status, run: mocks.run, pause: mocks.pause, configure: vi.fn() })),
  loadAppReadJobConfig: vi.fn(async () => ({ jobs: [] })),
}));
vi.mock("../../../packages/gateway/src/app-read-jobs/store.js", () => ({ createAppReadJobStore: mocks.store.mockImplementation(() => ({})) }));
const readService = { read: vi.fn(), authorize: vi.fn() };
const ai = { generate: vi.fn() };
it("starts without a renderer and maps authenticated owner aliases to one durable owner", async () => {
  vi.clearAllMocks();
  const app = new Hono();
  const runtime = createAppReadJobRuntime({ app, homePath: "/fixture", ownerIds: ["owner", "owner-alias"], db: {} as any, registry: { get: vi.fn() } as any, ensureAppProvisioned: vi.fn(), readService: readService as any, ai: ai as any, getPrincipal: () => ({ userId: "owner-alias" }) });
  expect(mocks.start).toHaveBeenCalledOnce();
  const response = await app.request("/api/app-read-jobs/run", { method: "POST", body: JSON.stringify({ app: "briefing", jobId: "daily" }) });
  expect(response.status).toBe(200);
  expect(mocks.run).toHaveBeenCalledWith("owner", "briefing", "daily");
  await runtime.stop();
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it("keeps unavailable database routes fail-closed and does not start a runner", async () => {
  vi.clearAllMocks();
  const app = new Hono();
  const runtime = createAppReadJobRuntime({ app, homePath: "/fixture", ownerIds: ["owner"], db: null, registry: null, ensureAppProvisioned: vi.fn(), readService: readService as any, ai: ai as any, getPrincipal: () => ({ userId: "owner" }) });
  expect(mocks.start).not.toHaveBeenCalled();
  expect((await app.request("/api/app-read-jobs/run", { method: "POST", body: JSON.stringify({ app: "briefing", jobId: "daily" }) })).status).toBe(503);
  await runtime.stop();
});
