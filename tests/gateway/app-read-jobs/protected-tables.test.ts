import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createQueryEngine } from "../../../packages/gateway/src/app-db-query.js";
import { registerBridgeDataRoutes } from "../../../packages/gateway/src/server/bridge-routes.js";

describe("trusted scheduler table writes", () => {
  it("denies every generic mutation before SQL, preserving normal owner reads", async () => {
    const raw = vi.fn(async () => ({ rows: [{ id: "record", count: 1 }] }));
    const engine = createQueryEngine({ raw } as never);
    for (const table of ["read_job_state", "read_job_runs", "read_job_snapshots"]) {
      await expect(engine.insert("briefing", table, { status: "completed" })).rejects.toThrow("read-only");
      await expect(engine.bulkInsert("briefing", table, [])).rejects.toThrow("read-only");
      await expect(engine.update("briefing", table, "record", { generation: 9 })).rejects.toThrow("read-only");
      await expect(engine.bulkUpdate("briefing", table, [])).rejects.toThrow("read-only");
      await expect(engine.delete("briefing", table, "record")).rejects.toThrow("read-only");
    }
    expect(raw).not.toHaveBeenCalled();
    expect(await engine.find("briefing", "read_job_snapshots")).toEqual([{ id: "record", count: 1 }]);
    expect(await engine.insert("briefing", "owner_overrides", { note: "local" })).toEqual({ id: "record" });
  });
  it("returns403 through the app/native shared bridge before provisioning or broadcasting", async () => {
    const app = new Hono(); const provision = vi.fn(); const broadcast = vi.fn(); const insert = vi.fn();
    registerBridgeDataRoutes(app, { homePath: "/unused", queryEngine: { insert } as never, appRegistry: {} as never,
      kvStore: null, ensureAppProvisioned: provision, broadcast, queryBodyLimit: bodyLimit({ maxSize: 100_000 }),
      dataBodyLimit: bodyLimit({ maxSize: 100_000 }), logUnexpectedJsonParseFailure: vi.fn() });
    const response = await app.request("/api/bridge/query", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "briefing", action: "insert", table: "read_job_runs", data: { status: "completed" } }) });
    expect(response.status).toBe(403); expect(provision).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
  });
});
