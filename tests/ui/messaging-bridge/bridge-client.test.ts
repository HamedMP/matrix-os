import { describe, expect, it, vi } from "vitest";
import {
  MESSAGING_BRIDGE_GENERIC_ERROR,
  MessagingBridgeClientError,
  createMessagingBridgeClient,
} from "../../../packages/ui/src/messaging/bridge-client";
import { conversation, conversations, fakeGateway, message, progress, readyWithAccounts } from "./fixtures";

const ROOM = "!room-a:bridge.example";

describe("messaging bridge client", () => {
  it("calls the owner routes with contract-parsed responses", async () => {
    const gateway = fakeGateway({
      "GET /api/messages/bridge/status": () => ({ body: readyWithAccounts() }),
      "POST /api/messages/bridge/whatsapp/link": () => ({ body: progress("whatsapp", { type: "display_and_wait", stepId: "qr-1", display: { kind: "qr", data: "2@abc" } }) }),
      "POST /api/messages/bridge/whatsapp/link/link-1/step": () => ({ body: progress("whatsapp", { type: "complete", loginId: "wa-1" }) }),
      "POST /api/messages/bridge/whatsapp/link/link-1/cancel": () => ({ body: { ok: true } }),
      "DELETE /api/messages/bridge/telegram/accounts/tg-1": () => ({ body: { ok: true } }),
      "GET /api/messages/bridge/conversations": () => ({ body: conversations([conversation({ roomId: ROOM })], "next-1") }),
      [`GET /api/messages/bridge/conversations/${encodeURIComponent(ROOM)}/messages`]: () => ({ body: { items: [message({ eventId: "$e1" })] } }),
      [`POST /api/messages/bridge/conversations/${encodeURIComponent(ROOM)}/send`]: () => ({ body: message({ eventId: "$e2", direction: "outgoing", delivery: "sent" }) }),
    });
    const client = createMessagingBridgeClient(gateway.fetch);

    expect((await client.status()).availability).toBe("ready");
    expect((await client.startLink("whatsapp")).step.type).toBe("display_and_wait");
    expect((await client.linkStep("whatsapp", "link-1", { stepId: "qr-1" })).step.type).toBe("complete");
    await expect(client.cancelLink("whatsapp", "link-1")).resolves.toBeUndefined();
    await expect(client.removeAccount("telegram", "tg-1")).resolves.toBeUndefined();
    expect((await client.conversations({ network: "telegram", cursor: "c1", limit: 20 })).nextCursor).toBe("next-1");
    expect((await client.messages(ROOM, { cursor: "older" })).items[0]?.eventId).toBe("$e1");
    expect((await client.send(ROOM, { body: "hi", clientTxnId: "txn-12345678" })).eventId).toBe("$e2");

    expect(gateway.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/messages/bridge/status",
      "POST /api/messages/bridge/whatsapp/link",
      "POST /api/messages/bridge/whatsapp/link/link-1/step",
      "POST /api/messages/bridge/whatsapp/link/link-1/cancel",
      "DELETE /api/messages/bridge/telegram/accounts/tg-1",
      "GET /api/messages/bridge/conversations?network=telegram&cursor=c1&limit=20",
      `GET /api/messages/bridge/conversations/${encodeURIComponent(ROOM)}/messages?cursor=older&limit=50`,
      `POST /api/messages/bridge/conversations/${encodeURIComponent(ROOM)}/send`,
    ]);
    expect(gateway.requests[1]?.body).toEqual({});
    expect(gateway.requests[2]?.body).toEqual({ stepId: "qr-1" });
    expect(gateway.requests[7]?.body).toEqual({ body: "hi", clientTxnId: "txn-12345678" });
    expect(gateway.requests.every((r) => r.signal instanceof AbortSignal)).toBe(true);
  });

  it("bounds ordinary calls at 10 s, link start at 45 s and the long-poll step at 35 s", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const gateway = fakeGateway({
      "GET /api/messages/bridge/status": () => ({ body: readyWithAccounts() }),
      "POST /api/messages/bridge/whatsapp/link": () => ({ body: progress("whatsapp", { type: "complete", loginId: "wa-1" }) }),
      "POST /api/messages/bridge/whatsapp/link/link-1/step": () => ({ body: progress("whatsapp", { type: "complete", loginId: "wa-1" }) }),
    });
    const client = createMessagingBridgeClient(gateway.fetch);
    await client.status();
    expect(timeout).toHaveBeenLastCalledWith(10_000);
    await client.startLink("whatsapp");
    expect(timeout).toHaveBeenLastCalledWith(45_000);
    await client.linkStep("whatsapp", "link-1", { stepId: "qr-1" });
    expect(timeout).toHaveBeenLastCalledWith(35_000);
    await client.linkStep("whatsapp", "link-1", { stepId: "form-1", fields: { phone: "+4670" } });
    expect(timeout).toHaveBeenLastCalledWith(10_000);
    timeout.mockRestore();
  });

  it.each([
    [{ error: { code: "rate_limited", message: "Slow down" } }, 429, "rate_limited", "Too many attempts. Wait a moment and try again."],
    [{ error: { code: "not_enabled", message: "x" } }, 403, "not_enabled", "Chat apps are not available on your account yet."],
    [{ error: { code: "bridge_unavailable", message: "mautrix-whatsapp crashed at /srv/bridge" } }, 503, "bridge_unavailable", "Chat apps are unavailable right now. Try again soon."],
  ])("maps error code to a fixed message and never echoes the server text", async (body, statusCode, code, text) => {
    const gateway = fakeGateway({ "GET /api/messages/bridge/status": () => ({ status: statusCode, body }) });
    const error = await createMessagingBridgeClient(gateway.fetch).status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessagingBridgeClientError);
    expect((error as MessagingBridgeClientError).code).toBe(code);
    expect((error as MessagingBridgeClientError).userMessage).toBe(text);
    expect((error as Error).message).not.toMatch(/mautrix|srv|Slow down/);
  });

  it.each([
    ["unknown code", 500, { error: { code: "postgres_down", message: "relation messaging_messages does not exist" } }],
    ["long message", 500, { error: { code: "internal", message: "x".repeat(5000) } }],
    ["non-JSON shape", 502, "Bad gateway from nginx"],
    ["empty body", 500, undefined],
  ])("falls back to the generic message for %s", async (_label, statusCode, body) => {
    const gateway = fakeGateway({ "GET /api/messages/bridge/status": () => ({ status: statusCode, body }) });
    const error = (await createMessagingBridgeClient(gateway.fetch).status().catch((e: unknown) => e)) as MessagingBridgeClientError;
    expect(error).toBeInstanceOf(MessagingBridgeClientError);
    expect(error.userMessage).toBe(MESSAGING_BRIDGE_GENERIC_ERROR);
  });

  it("rejects a successful response that does not match the contract", async () => {
    const gateway = fakeGateway({ "GET /api/messages/bridge/status": () => ({ body: { availability: "ready", networks: [{ network: "signal", accounts: [] }] } }) });
    const error = (await createMessagingBridgeClient(gateway.fetch).status().catch((e: unknown) => e)) as MessagingBridgeClientError;
    expect(error.code).toBe("invalid_response");
    expect(error.userMessage).toBe(MESSAGING_BRIDGE_GENERIC_ERROR);
  });

  it("refuses invalid path params before any request is made", async () => {
    const gateway = fakeGateway({});
    const client = createMessagingBridgeClient(gateway.fetch);
    await expect(client.removeAccount("whatsapp", "../../etc")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.messages("not-a-room")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.send(ROOM, { body: "   ", clientTxnId: "txn-12345678" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(gateway.requests).toHaveLength(0);
  });

  it("reports caller cancellation as aborted and network loss as offline", async () => {
    const pending = fakeGateway({ "GET /api/messages/bridge/status": () => new Promise(() => {}) });
    const controller = new AbortController();
    const call = createMessagingBridgeClient(pending.fetch).status(controller.signal);
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: "aborted" });

    const offline = createMessagingBridgeClient(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(offline.status()).rejects.toMatchObject({ code: "offline", userMessage: "Can't reach your Matrix computer. Check your connection." });
  });
});
