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
  it("runs matching automation rules for automation-queued bridge events", async () => {
    const roomId = "!room:matrixos.local";
    const replyId = "reply_0123456789abcdef0123456789abcdef";
    const ingestBridgeEvent = vi.fn().mockResolvedValue({ accepted: true, effect: "automation_queued" });
    const getPermission = vi.fn().mockResolvedValue({
      ownerId,
      roomId,
      readEnabled: false,
      replyEnabled: false,
      automationEnabled: true,
      mentionOnly: false,
      revision: 3,
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    const roomRuleId = "auto_0123456789abcdef0123456789abcdef";
    const allPermittedRuleId = "auto_abcdef0123456789abcdef0123456789";
    const listAutomationRules = vi.fn().mockResolvedValue({
      items: [
        {
          id: roomRuleId,
          ownerId,
          name: "Deadlines",
          scope: "room",
          roomId,
          trigger: { type: "text_contains", value: "deadline" },
          action: { type: "draft_reply", bodyTemplate: "I saw: {body}" },
          status: "enabled",
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:00:00.000Z",
        },
        {
          id: allPermittedRuleId,
          ownerId,
          name: "All deadlines",
          scope: "all_permitted",
          trigger: { type: "text_contains", value: "deadline" },
          action: { type: "create_task", titleTemplate: "Follow up: {body}" },
          status: "enabled",
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:00:00.000Z",
        },
      ],
      nextCursor: undefined,
    });
    const enqueueHermesWork = vi.fn().mockResolvedValue({
      id: "work_0123456789abcdef0123456789abcdef",
      ownerId,
      roomId,
      sourceEventId: "$event2:matrixos.local",
      kind: "automation",
      status: "queued",
      permissionRevision: 3,
      abortTokenId: "abort_0123456789abcdef0123456789abcdef",
      metadata: { action: "create_task", ruleTitle: "Follow up: deadline tomorrow" },
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    const createReply = vi.fn().mockResolvedValue({
      id: replyId,
      ownerId,
      roomId,
      source: "automation",
      status: "approval_required",
      body: "I saw: deadline tomorrow",
      permissionRevision: 3,
      clientTxnId: "auto_test",
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    const repository = createRepositoryMock({ ingestBridgeEvent, getPermission, listAutomationRules, createReply, enqueueHermesWork });
    const app = createMessagingTestApp(repository, null);

    const res = await app.request("/api/messages/appservice/whatsapp/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-OS-Appservice-Token": "test-appservice-token",
      },
      body: JSON.stringify({
        events: [{
          eventId: "$event2:matrixos.local",
          roomId,
          accountId: "acct_0123456789abcdef0123456789abcdef",
          type: "message",
          sender: { displayName: "Ada" },
          content: { kind: "text", body: "deadline tomorrow" },
          occurredAt: "2026-05-13T00:00:00.000Z",
        }],
      }),
    });

    expect(res.status).toBe(202);
    expect(listAutomationRules).toHaveBeenCalledWith({ ownerId }, { roomId, limit: 100 });
    expect(createReply).toHaveBeenCalledWith(expect.objectContaining({
      ownerId,
      roomId,
      source: "automation",
      status: "approval_required",
      body: "I saw: deadline tomorrow",
      permissionRevision: 3,
    }));
    expect(enqueueHermesWork).toHaveBeenCalledWith(expect.objectContaining({
      ownerId,
      roomId,
      sourceEventId: "$event2:matrixos.local",
      kind: "automation",
      permissionRevision: 3,
      metadata: {
        action: "create_task",
        ruleTitle: "Follow up: deadline tomorrow",
      },
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
