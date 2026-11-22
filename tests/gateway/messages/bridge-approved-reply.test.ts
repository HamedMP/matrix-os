import { describe, expect, it, vi } from "vitest";
import type { MessagingBridgeService } from "../../../packages/gateway/src/messages/bridge-service.js";
import { MessagingBridgeServiceError } from "../../../packages/gateway/src/messages/bridge-service.js";
import { createMessagingTestApp, createRepositoryMock, now, ownerId } from "./helpers.js";

const replyId = "reply_0123456789abcdef0123456789abcdef";
const roomId = "!portal:bridge.example.test";

function reply(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: replyId,
    ownerId,
    roomId,
    source: "hermes",
    status,
    body: "Approved body",
    permissionRevision: 2,
    clientTxnId: "txn_hermes",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function bridge(deliver: MessagingBridgeService["deliver"]): MessagingBridgeService {
  return { ownerId, deliver } as unknown as MessagingBridgeService;
}

async function approve(app: ReturnType<typeof createMessagingTestApp>) {
  const res = await app.request(`/api/messages/drafts/${replyId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseStatus: "approval_required" }),
  });
  return { status: res.status, body: await res.json() };
}

describe("approved 077 replies through the bridge", () => {
  it("delivers an approved reply with the reply id as the transaction id and records the event id", async () => {
    const deliver = vi.fn(async () => ({
      eventId: "$delivered",
      clientTxnId: replyId,
      direction: "outgoing" as const,
      senderName: "You",
      kind: "text" as const,
      body: "Approved body",
      occurredAt: now,
      delivery: "sent" as const,
    }));
    const markReplySent = vi.fn().mockResolvedValue(reply("sent", { matrixEventId: "$delivered" }));
    const repository = createRepositoryMock({
      approveReply: vi.fn().mockResolvedValue({ replyId, status: "sending" }),
      getReply: vi.fn().mockResolvedValue(reply("sending")),
      markReplySent,
    });
    const app = createMessagingTestApp(repository, ownerId, { bridge: bridge(deliver) });

    expect(await approve(app)).toEqual({ status: 202, body: { replyId, status: "sent", matrixEventId: "$delivered" } });
    expect(deliver).toHaveBeenCalledWith(ownerId, roomId, { body: "Approved body", clientTxnId: replyId });
    expect(markReplySent).toHaveBeenCalledWith({ ownerId, replyId, matrixEventId: "$delivered" });
  });

  it("marks the reply failed when delivery fails", async () => {
    const deliver = vi.fn(async () => {
      throw new MessagingBridgeServiceError("not_found");
    });
    const markReplyFailed = vi.fn().mockResolvedValue(reply("failed", { failureCode: "send_failed" }));
    const repository = createRepositoryMock({
      approveReply: vi.fn().mockResolvedValue({ replyId, status: "sending" }),
      getReply: vi.fn().mockResolvedValue(reply("sending")),
      markReplyFailed,
    });
    const app = createMessagingTestApp(repository, ownerId, { bridge: bridge(deliver) });

    expect(await approve(app)).toEqual({ status: 202, body: { replyId, status: "failed" } });
    expect(markReplyFailed).toHaveBeenCalledWith({ ownerId, replyId, failureCode: "send_failed" });
  });

  it("leaves the reply sending when no bridge is configured", async () => {
    const getReply = vi.fn();
    const repository = createRepositoryMock({
      approveReply: vi.fn().mockResolvedValue({ replyId, status: "sending" }),
      getReply,
    });
    const app = createMessagingTestApp(repository, ownerId, { bridge: null });

    expect(await approve(app)).toEqual({ status: 202, body: { replyId, status: "sending" } });
    expect(getReply).not.toHaveBeenCalled();
  });
});
