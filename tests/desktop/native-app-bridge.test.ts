import { describe, expect, it, vi } from "vitest";
import {
  NativeAppQuerySchema,
  createNativeAppDatabase,
} from "@desktop/shared/native-app-bridge";
import { NativeAppBridge } from "@desktop/main/embeds/native-app-bridge";
import { createNativeAppQueryRequester } from "@desktop/main/embeds/native-app-bridge";

describe("native app database bridge", () => {
  it("builds the same scoped database calls used by shell-hosted apps", async () => {
    const invoke = vi.fn(async () => [{ id: "note-1" }]);
    const db = createNativeAppDatabase(invoke);

    await expect(db.find("notes", { orderBy: { updated_at: "desc" } }))
      .resolves.toEqual([{ id: "note-1" }]);
    expect(invoke).toHaveBeenCalledWith({
      action: "find",
      table: "notes",
      orderBy: { updated_at: "desc" },
    });
    expect("app" in invoke.mock.calls[0]![0]).toBe(false);
  });

  it("notifies bounded table subscribers after successful local mutations", async () => {
    const invoke = vi.fn(async (query: { action: string }) => query.action === "insert"
      ? { id: "note-1" }
      : { ok: true });
    const db = createNativeAppDatabase(invoke);
    const listener = vi.fn();
    const unsubscribe = db.onChange("notes", listener);

    await db.insert("notes", { title: "Native" });
    expect(listener).toHaveBeenCalledWith({ table: "notes" });

    unsubscribe();
    await db.update("notes", "note-1", { title: "Updated" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects app identity spoofing and malformed or oversized queries", () => {
    expect(NativeAppQuerySchema.safeParse({
      app: "todo",
      action: "find",
      table: "notes",
    }).success).toBe(false);
    expect(NativeAppQuerySchema.safeParse({ action: "find", table: "../notes" }).success)
      .toBe(false);
    expect(NativeAppQuerySchema.safeParse({
      action: "insert",
      table: "notes",
      data: { content: "x".repeat(300_000) },
    }).success).toBe(false);
  });

  it("binds each sender to its registered app slug and current app URL", async () => {
    const request = vi.fn(async (_slug: string, _query: unknown) => ({ id: "db-note" }));
    const bridge = new NativeAppBridge({
      request,
      gatewayOrigin: () => "https://gateway.test",
    });
    bridge.register(42, "notes");

    await expect(bridge.query({
      id: 42,
      url: "https://gateway.test/apps/notes/?session=token",
    }, { action: "insert", table: "notes", data: { title: "Native" } }))
      .resolves.toEqual({ id: "db-note" });
    expect(request).toHaveBeenCalledWith("notes", {
      action: "insert",
      table: "notes",
      data: { title: "Native" },
    });

    await expect(bridge.query({
      id: 42,
      url: "https://gateway.test/apps/todo/?session=token",
    }, { action: "find", table: "notes" })).rejects.toThrow("not authorized");
    await expect(bridge.query({
      id: 99,
      url: "https://gateway.test/apps/notes/",
    }, { action: "find", table: "notes" })).rejects.toThrow("not authorized");
  });

  it("evicts sender registrations when views close and caps retained identities", async () => {
    const bridge = new NativeAppBridge({
      request: vi.fn(async () => []),
      gatewayOrigin: () => "https://gateway.test",
      maxSenders: 2,
    });
    bridge.register(1, "notes");
    bridge.register(2, "todo");
    bridge.register(3, "calendar");

    await expect(bridge.query({ id: 1, url: "https://gateway.test/apps/notes/" }, {
      action: "find",
      table: "notes",
    })).rejects.toThrow("not authorized");
    bridge.unregister(3);
    await expect(bridge.query({ id: 3, url: "https://gateway.test/apps/calendar/" }, {
      action: "find",
      table: "events",
    })).rejects.toThrow("not authorized");
  });

  it("sends an authenticated, bounded request with the authoritative app slug", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([{ id: "note-1" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const request = createNativeAppQueryRequester({
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "desktop-token",
      fetchFn,
    });

    await expect(request("notes", { action: "find", table: "notes" }))
      .resolves.toEqual([{ id: "note-1" }]);
    expect(fetchFn).toHaveBeenCalledWith("https://gateway.test/api/bridge/query", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer desktop-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ app: "notes", action: "find", table: "notes" }),
      signal: expect.any(AbortSignal),
    }));
  });

  it("accepts canonical nested app identities while preserving them for gateway normalization", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const request = createNativeAppQueryRequester({
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "desktop-token",
      fetchFn,
    });

    await expect(request("games/2048", { action: "find", table: "scores" }))
      .resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://gateway.test/api/bridge/query",
      expect.objectContaining({
        body: JSON.stringify({ app: "games/2048", action: "find", table: "scores" }),
      }),
    );

    const bridge = new NativeAppBridge({ request, gatewayOrigin: () => "https://gateway.test" });
    bridge.register(77, "games/2048", "2048");
    await expect(bridge.query(
      { id: 77, url: "https://gateway.test/apps/2048/" },
      { action: "find", table: "scores" },
    )).resolves.toEqual([]);
  });

  it("rejects successful gateway responses that do not match the requested action", async () => {
    const request = createNativeAppQueryRequester({
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "desktop-token",
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ rows: "not-an-array" }), { status: 200 })),
    });

    await expect(request("notes", { action: "find", table: "notes" }))
      .rejects.toThrow("invalid database response");
  });

  it("accepts a null installed version for legacy app registrations", async () => {
    const request = createNativeAppQueryRequester({
      getGatewayOrigin: () => "https://gateway.test",
      getToken: () => "desktop-token",
      fetchFn: vi.fn(async () => new Response(
        JSON.stringify({ installedVersion: null }),
        { status: 200 },
      )),
    });

    await expect(request("clock", { action: "appInfo" }))
      .resolves.toEqual({ installedVersion: null });
  });
});
