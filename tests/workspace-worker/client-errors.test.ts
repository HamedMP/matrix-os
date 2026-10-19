import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceRoutes } from "../../packages/workspace-worker/src/routes.js";
import type { WorkspaceRepository } from "../../packages/workspace-worker/src/data/repository.js";

const token = "client_error_preview_test_token";
const runtime = { status: vi.fn(), enqueue: vi.fn() };
const app = () => createWorkspaceRoutes({
  repository: {} as WorkspaceRepository,
  files: { read: vi.fn(), write: vi.fn(), remove: vi.fn() }, runtime,
  auth: { previewBearer: { token, ownerId: "verified_owner" } }, previewEnabled: true,
});
const report = { errorId: "mx-18mp5k4-119037a7", source: "shell-global-error-boundary",
  name: "TypeError", message: "Test render failure", stack: "TypeError: Test render failure\n at shell.js:2:3",
  path: "/workspace?private=value", userAgent: "private browser detail", buildSha: "test-build" };
const request = (body: unknown, authorized = true) => new Request("https://saved.test/api/client-errors", {
  method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("shared desktop crash reports", () => {
  it("records a bounded authenticated exception without waking compute or echoing it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await app().fetch(request(report));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(log).toHaveBeenCalledWith("[workspace-client-error]", expect.objectContaining({
      ownerId: "verified_owner", errorId: report.errorId, message: report.message, stack: report.stack,
      path: "/workspace", buildSha: "test-build",
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect(runtime.enqueue).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated, forged, malformed and oversized reports before logging", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await app().fetch(request(report, false))).status).toBe(401);
    for (const body of [{ ...report, ownerId: "victim" }, { ...report, message: "x".repeat(1001) }, { ...report, errorId: "bad" }]) {
      expect((await app().fetch(request(body))).status).toBe(400);
    }
    expect((await app().fetch(request({ ...report, stack: "x".repeat(17_000) }))).status).toBe(413);
    expect(log).not.toHaveBeenCalledWith("[workspace-client-error]", expect.anything());
  });
});
