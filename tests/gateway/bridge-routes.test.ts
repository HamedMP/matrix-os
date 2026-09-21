import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createBridgeRoutes, type BridgeRouteDeps } from "../../packages/gateway/src/routes/bridge.js";

function createDeps(overrides: Partial<BridgeRouteDeps> = {}): BridgeRouteDeps & {
  kvRead: ReturnType<typeof vi.fn>;
  kvWrite: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
} {
  const kvRead = vi.fn(async () => "stored-value");
  const kvWrite = vi.fn(async () => undefined);
  const broadcast = vi.fn();
  return {
    dispatcher: { dispatch: vi.fn(async () => undefined) } as unknown as BridgeRouteDeps["dispatcher"],
    getQueryEngine: () => null,
    getAppRegistry: () => null,
    getKvStore: () => ({ read: kvRead, write: kvWrite }) as unknown as NonNullable<ReturnType<BridgeRouteDeps["getKvStore"]>>,
    homePath: "/tmp/bridge-routes-test-home",
    ensureAppProvisioned: vi.fn(async () => undefined),
    broadcast,
    logUnexpectedJsonParseFailure: vi.fn(),
    integrationBridge: { platformDb: null, pipedream: null, resolveUserId: null },
    kvRead,
    kvWrite,
    broadcast,
    ...overrides,
  };
}

function createApp(deps: BridgeRouteDeps): Hono {
  const app = new Hono();
  app.route("/", createBridgeRoutes(deps));
  return app;
}

describe("bridge routes — boundary validation", () => {
  it("rejects an unknown bridge/data action instead of treating it as a write", async () => {
    const deps = createDeps();
    const res = await createApp(deps).request("/api/bridge/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", app: "notes", key: "k" }),
    });
    expect(res.status).toBe(400);
    expect(deps.kvWrite).not.toHaveBeenCalled();
  });

  it("still serves valid read and write actions", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    const readRes = await app.request("/api/bridge/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "read", app: "notes", key: "k" }),
    });
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual({ value: "stored-value" });

    const writeRes = await app.request("/api/bridge/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "write", app: "notes", key: "k", value: "v" }),
    });
    expect(writeRes.status).toBe(200);
    expect(deps.kvWrite).toHaveBeenCalledWith("notes", "k", "v");
    expect(deps.broadcast).toHaveBeenCalledWith({ type: "data:change", app: "notes", key: "k" });
  });

  it("rejects bridge/data GET without app/key and proxy without url", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    expect((await app.request("/api/bridge/data?app=notes")).status).toBe(400);
    expect((await app.request("/api/bridge/proxy")).status).toBe(400);
  });

  it("rejects an overlong proxy url at the boundary", async () => {
    const deps = createDeps();
    const res = await createApp(deps).request(`/api/bridge/proxy?url=https://x/${"a".repeat(2048)}`);
    expect(res.status).toBe(400);
  });

  it("rejects a non-https or non-allowlisted proxy url", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    expect((await app.request("/api/bridge/proxy?url=http://api.open-meteo.com/v1/x")).status).toBe(403);
    expect((await app.request("/api/bridge/proxy?url=https://evil.example.com/x")).status).toBe(403);
  });
});
