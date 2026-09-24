import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { registerBridgeDataRoutes } from "../../packages/gateway/src/server/bridge-routes.js";

describe("gateway bridge route registration", () => {
  let homePath: string;
  let app: Hono;
  const broadcast = vi.fn();

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-bridge-route-"));
    app = new Hono();
    registerBridgeDataRoutes(app, {
      homePath,
      queryEngine: null,
      appRegistry: null,
      kvStore: null,
      ensureAppProvisioned: async () => undefined,
      broadcast,
      queryBodyLimit: bodyLimit({ maxSize: 1_000_000 }),
      dataBodyLimit: bodyLimit({ maxSize: 1_000_000 }),
      logUnexpectedJsonParseFailure: vi.fn(),
    });
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
    broadcast.mockReset();
  });

  it("keeps structured queries unavailable without the owner database", async () => {
    const response = await app.request("/api/bridge/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "listApps" }),
    });
    expect(response.status).toBe(503);
  });

  it("rejects a private proxy target before any outbound fetch", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    try {
      const response = await app.request("/api/bridge/proxy?url=http%3A%2F%2F127.0.0.1%2Fsecret");
      expect(response.status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });

  it("preserves file-storage KV fallback when Postgres is unavailable", async () => {
    const written = await app.request("/api/bridge/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "write", app: "board", key: "theme", value: "dark" }),
    });
    expect(written.status).toBe(200);
    const read = await app.request("/api/bridge/data?app=board&key=theme");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ value: "dark" });
    expect(broadcast).toHaveBeenCalledWith({ type: "data:change", app: "board", key: "theme" });
  });

  it("rejects an unrecognized KV action instead of falling through to a write", async () => {
    const response = await app.request("/api/bridge/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "raed", app: "board", key: "theme", value: "hijacked" }),
    });
    expect(response.status).toBe(400);
    expect(broadcast).not.toHaveBeenCalled();
    const read = await app.request("/api/bridge/data?app=board&key=theme");
    expect(await read.json()).toEqual({ value: null });
  });

  it("rejects a non-string KV value instead of coercing it onto disk", async () => {
    const response = await app.request("/api/bridge/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "write", app: "board", key: "theme", value: { nested: true } }),
    });
    expect(response.status).toBe(400);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
