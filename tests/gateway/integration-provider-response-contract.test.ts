import { describe, expect, it, vi } from "vitest";
import { createBotIntegrationClient, createLocalIntegrationTransport, BotIntegrationError } from "../../packages/gateway/src/bots/integration-client.js";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";
import { createBoundedPipedreamGet } from "../../packages/gateway/src/integrations/pipedream-bounded-get.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { GOOGLE_SERVICES } from "../../packages/gateway/src/integrations/google.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";

const attachmentInput = { service: "gmail", action: "get_attachment", label: "Work", connectionId: "conn_1", params: { messageId: "abc", attachmentId: "attach_1" }, read: true };

describe("provider response contracts through real read consumers", () => {
  it("returns a 1 MiB decoded attachment through the executor, read route and local client", async () => {
    const data = Buffer.alloc(1024 * 1024, 97).toString("base64url");
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ size: 1024 * 1024, data }));
    const proxyGet = vi.fn(); const runAction = vi.fn();
    const boundedGmailGet = createBoundedPipedreamGet({ projectId: "project", environment: "production", getAccessToken: async () => "token", fetcher });
    const db = { listConnectedServices: vi.fn(async () => [{ id: "conn_1", service: "gmail", account_label: "Work", pipedream_account_id: "account" }]),
      getUserById: vi.fn(async () => ({ pipedream_external_id: "owner" })), touchServiceUsage: vi.fn(async () => undefined) };
    const routes = createIntegrationReadCallRoutes({ db: db as unknown as PlatformDb,
      pipedream: { boundedGmailGet, proxyGet, runAction } as unknown as PipedreamConnectClient,
      resolveUserId: async c => c.req.header("x-platform-user-id") ?? null });
    const result = await createBotIntegrationClient(createLocalIntegrationTransport(routes)).call("owner", attachmentInput);
    expect(result).toEqual({ data: { size: 1024 * 1024, data } });
    expect(fetcher).toHaveBeenCalledOnce(); expect(db.touchServiceUsage).toHaveBeenCalledExactlyOnceWith("conn_1");
    const proxy = new URL(fetcher.mock.calls[0]![0]);
    expect(proxy.searchParams.get("account_id")).toBe("account");
    expect(proxyGet).not.toHaveBeenCalled(); expect(runAction).not.toHaveBeenCalled();
  });

  it("cancels an advertised oversized attachment envelope before reading it", async () => {
    const cancel = vi.fn(); const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const client = createBotIntegrationClient(async () => new Response(body, { headers: { "content-length": String(2 * 1024 * 1024) } }));
    await expect(client.call("owner", attachmentInput)).rejects.toEqual(new BotIntegrationError("unavailable"));
    expect(cancel).toHaveBeenCalledOnce(); expect(pull).not.toHaveBeenCalled();
  });

  it("cancels an oversized streamed attachment without a declared length", async () => {
    const cancel = vi.fn();
    const client = createBotIntegrationClient(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2 * 1024 * 1024)); }, cancel })));
    await expect(client.call("owner", attachmentInput)).rejects.toEqual(new BotIntegrationError("unavailable"));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { service: "gmail", action: "get_message", read: true },
    { service: "unknown", action: "get_attachment", read: true },
    { service: "gmail", action: "get_attachment", read: false },
  ])("retains the standard cap outside the exact read attachment action %j", async override => {
    const cancel = vi.fn(); const pull = vi.fn();
    const client = createBotIntegrationClient(async () => new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), { headers: { "content-length": String(300 * 1024) } }));
    await expect(client.call("owner", { ...attachmentInput, ...override })).rejects.toEqual(new BotIntegrationError("unavailable", !override.read));
    expect(cancel).toHaveBeenCalledOnce(); expect(pull).not.toHaveBeenCalled();
  });

  it("executes a discovered official holiday calendar identifier as one encoded path segment", async () => {
    const service = GOOGLE_SERVICES.google_calendar;
    const proxyGet = vi.fn(async (_input: { url: string }) => ({ items: [] }));
    const runAction = vi.fn();
    await executeIntegrationAction({ pipedream: { proxyGet, runAction } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "account" }, def: service,
      actionDef: service.actions.list_events, serviceId: service.id, actionId: "list_events",
      params: { calendarId: "en.usa#holiday@group.v.calendar.google.com" } });
    const url = new URL(proxyGet.mock.calls[0]![0].url);
    expect(url.origin).toBe("https://www.googleapis.com");
    expect(url.pathname).toContain("en.usa%23holiday%40group.v.calendar.google.com/events");
    expect(url.hash).toBe(""); expect(runAction).not.toHaveBeenCalled();
    for (const calendarId of ["../other", "abc/../other", "abc\u0000", "https://other.invalid"]) {
      await expect(executeIntegrationAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient,
        externalUserId: "owner", connection: { pipedream_account_id: "account" }, def: service,
        actionDef: service.actions.list_events, serviceId: service.id, actionId: "list_events", params: { calendarId } })).rejects.toThrow("Invalid action parameters");
    }
    expect(proxyGet).toHaveBeenCalledOnce();
  });
});
