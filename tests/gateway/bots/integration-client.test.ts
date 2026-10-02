import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  BotIntegrationError,
  createBotIntegrationClient,
  createLocalIntegrationTransport,
  createPlatformIntegrationTransport,
} from "../../../packages/gateway/src/bots/integration-client.js";

const OWNER = "user_owner_1";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("bot integration client", () => {
  it("calls the platform as the owner with the machine token and a signed delegation", async () => {
    const fetchImpl = vi.fn(async () => json([
      { id: "conn_1", service: "gmail", account_label: "Work", account_email: "me@example.com", status: "active" },
      { id: "conn_2", service: "gmail", account_label: "Old", account_email: null, status: "revoked" },
    ]));
    const client = createBotIntegrationClient(createPlatformIntegrationTransport({
      baseUrl: "https://platform.internal/internal/containers/handle/integrations/", machineToken: "machine-token", fetchImpl: fetchImpl as never,
    }));
    await expect(client.inventory(OWNER)).resolves.toEqual([{ connectionId: "conn_1", service: "gmail", label: "Work" }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://platform.internal/internal/containers/handle/integrations");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer machine-token");
    expect(headers.get("x-platform-user-id")).toBe(OWNER);
    expect(headers.get("x-platform-verified")).toBe(createHmac("sha256", "machine-token").update(OWNER).digest("hex"));
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the read-only route and read scope for reads, and the call route for writes", async () => {
    const fetchImpl = vi.fn(async () => json({ data: { ok: true }, service: "gmail", action: "x", summary: "Done" }));
    const client = createBotIntegrationClient(createPlatformIntegrationTransport({ baseUrl: "https://platform.internal/i", machineToken: "t", fetchImpl: fetchImpl as never }));
    await expect(client.call(OWNER, { service: "gmail", action: "list_threads", label: "Work", params: {}, read: true }))
      .resolves.toEqual({ data: { ok: true }, summary: "Done" });
    await client.call(OWNER, { service: "gmail", action: "send_email", label: "Work", params: { to: "a" }, read: false });
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual(["https://platform.internal/i/read-call", "https://platform.internal/i/call"]);
    expect(new Headers(calls[0]![1].headers).get("x-matrix-integration-read-scope")).toBe("read");
    expect(new Headers(calls[1]![1].headers).get("x-matrix-integration-read-scope")).toBeNull();
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ service: "gmail", action: "send_email", label: "Work", params: { to: "a" } });
  });

  it("maps upstream failures to allowlisted codes and bounds what it reads", async () => {
    for (const [status, code] of [[409, "ambiguous"], [404, "missing"], [400, "missing"], [403, "denied"], [502, "unavailable"]] as const) {
      const client = createBotIntegrationClient(async () => json({ error: "provider said something at /secret" }, status));
      await expect(client.inventory(OWNER)).rejects.toEqual(new BotIntegrationError(code));
    }
    const huge = createBotIntegrationClient(async () => new Response("x".repeat(300 * 1024), { headers: { "content-length": String(300 * 1024) } }));
    await expect(huge.call(OWNER, { service: "gmail", action: "list_threads", label: "Work", params: {}, read: true })).rejects.toEqual(new BotIntegrationError("unavailable"));
    await expect(createBotIntegrationClient(async () => json({ not: "a list" })).inventory(OWNER)).rejects.toEqual(new BotIntegrationError("unavailable"));
    await expect(createBotIntegrationClient(async () => { throw new TypeError("network down"); }).inventory(OWNER)).rejects.toEqual(new BotIntegrationError("unavailable"));
  });

  it("starts a connection with an https consent URL only, and syncs", async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("/connect")
      ? json({ url: "https://connect.example/oauth?state=abc", service: "gmail" })
      : json({ synced: 1, services: [] })));
    const client = createBotIntegrationClient(createPlatformIntegrationTransport({ baseUrl: "https://platform.internal/i", machineToken: "t", fetchImpl: fetchImpl as never }));
    await expect(client.connect(OWNER, "gmail")).resolves.toBe("https://connect.example/oauth?state=abc");
    await expect(client.sync(OWNER)).resolves.toBeUndefined();
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([["https://platform.internal/i/connect", "POST"], ["https://platform.internal/i/sync", "POST"]]);
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ service: "gmail" });
    const insecure = createBotIntegrationClient(async () => json({ url: "http://connect.example/oauth" }));
    await expect(insecure.connect(OWNER, "gmail")).rejects.toEqual(new BotIntegrationError("unavailable"));
  });

  it("calls local integration routes in process as the owner", async () => {
    const routes = new Hono();
    const seen = vi.fn();
    routes.get("/", (context) => {
      seen(context.req.header("x-platform-user-id"));
      return context.json([{ id: "conn_1", service: "gmail", account_label: "Work", status: "active" }]);
    });
    const client = createBotIntegrationClient(createLocalIntegrationTransport(routes));
    await expect(client.inventory(OWNER)).resolves.toEqual([{ connectionId: "conn_1", service: "gmail", label: "Work" }]);
    expect(seen).toHaveBeenCalledWith(OWNER);
  });
});
