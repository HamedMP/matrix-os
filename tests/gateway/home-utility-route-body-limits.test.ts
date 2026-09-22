import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHomeUtilityRoutes } from "../../packages/gateway/src/server/home-utility-routes.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function mountedRoutes() {
  const homePath = mkdtempSync(join(tmpdir(), "home-utility-routes-"));
  homes.push(homePath);
  // Register the module the proxy test targets, so the handler would reach its
  // upstream fetch if the body limit did not run first.
  mkdirSync(join(homePath, "system"), { recursive: true });
  writeFileSync(
    join(homePath, "system", "modules.json"),
    JSON.stringify([{ name: "reporting", port: 45999, status: "running" }]),
    "utf-8",
  );
  const app = new Hono();
  const removeJob = vi.fn(() => false);
  registerHomeUtilityRoutes({
    app,
    homePath,
    conversations: {} as never,
    canvasService: null,
    dispatcher: { db: {} } as never,
    cronService: { listJobs: () => [], addJob: vi.fn(), removeJob } as never,
    channelManager: { status: () => ({}) } as never,
    interactionLogger: {} as never,
    broadcast: vi.fn(),
    logBestEffortFailure: vi.fn(),
  });
  return { app, removeJob };
}

describe("home utility route body limits", () => {
  it("limits a forwarded module proxy body before any upstream request", async () => {
    const { app } = mountedRoutes();
    const fetcher = vi.spyOn(globalThis, "fetch");
    try {
      const response = await app.request("/modules/reporting/ingest", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(6 * 1024 * 1024) },
        body: "x".repeat(1024),
      });
      expect(response.status).toBe(413);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });

  it("limits a cron delete body before removing the job", async () => {
    const { app, removeJob } = mountedRoutes();
    const response = await app.request("/api/cron/job_1", {
      method: "DELETE",
      headers: { "content-type": "application/json", "content-length": String(128 * 1024) },
      body: "x".repeat(1024),
    });
    expect(response.status).toBe(413);
    expect(removeJob).not.toHaveBeenCalled();
  });
});
