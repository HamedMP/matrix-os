import { describe, expect, it, vi } from "vitest";
import { createMessagingTestApp, createRepositoryMock, ownerId } from "./helpers.js";

describe("appservice event ingestion", () => {
  it("accepts trusted Matrix event batches and uses homeserver event ids for dedupe", async () => {
    const ingestBridgeEvent = vi
      .fn()
      .mockResolvedValueOnce({ accepted: true, effect: "stored_only" })
      .mockResolvedValueOnce({ accepted: false, effect: "ignored" });
    const repository = createRepositoryMock({ ingestBridgeEvent });
    const app = createMessagingTestApp(repository, null);

    const body = {
      events: [{
        eventId: "$event1:matrixos.local",
        externalEventId: "wa_duplicate",
        roomId: "!room:matrixos.local",
        accountId: "acct_0123456789abcdef0123456789abcdef",
        type: "message",
        sender: { displayName: "Ada" },
        content: { kind: "text", body: "ping" },
        occurredAt: "2026-05-13T00:00:00.000Z",
      }, {
        eventId: "$event1:matrixos.local",
        externalEventId: "wa_duplicate_2",
        roomId: "!room:matrixos.local",
        accountId: "acct_0123456789abcdef0123456789abcdef",
        type: "message",
        sender: { displayName: "Ada" },
        content: { kind: "text", body: "ping" },
        occurredAt: "2026-05-13T00:00:00.000Z",
      }],
    };

    const res = await app.request("/api/messages/appservice/whatsapp/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-OS-Appservice-Token": "test-appservice-token",
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, ignored: 1 });
    expect(ingestBridgeEvent).toHaveBeenCalledWith(expect.objectContaining({
      ownerId,
      networkSlug: "whatsapp",
      eventId: "$event1:matrixos.local",
    }));
  });

  it("rejects appservice events without the trusted token", async () => {
    const ingestBridgeEvent = vi.fn();
    const repository = createRepositoryMock({ ingestBridgeEvent });
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/appservice/telegram/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });

    expect(res.status).toBe(401);
    expect(ingestBridgeEvent).not.toHaveBeenCalled();
  });
});
