import { describe, expect, it, vi } from "vitest";
import { createMessagingTestApp, createRepositoryMock, ownerId, now } from "./helpers.js";
import { createHermesCapabilityToken } from "../../../packages/gateway/src/messages/hermes-capability.js";

const replyId = "reply_0123456789abcdef0123456789abcdef";
const roomId = "!room:matrixos.local";

describe("messaging draft and reply routes", () => {
  it("creates approval-required replies when room reply permission is missing", async () => {
    const createReplyAfterPermissionCheck = vi.fn().mockResolvedValue({
      replyId,
      status: "approval_required",
    });
    const repository = createRepositoryMock({ createReplyAfterPermissionCheck });
    const app = createMessagingTestApp(repository);

    const res = await app.request(`/api/messages/conversations/${encodeURIComponent(roomId)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "user", body: "I can make that time.", mode: "draft_if_not_allowed" }),
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ replyId, status: "approval_required" });
    expect(createReplyAfterPermissionCheck).toHaveBeenCalledWith(expect.objectContaining({
      ownerId,
      roomId,
      mode: "draft_if_not_allowed",
      source: "user",
    }));
  });

  it("requires a Hermes capability for non-user replies", async () => {
    const createReplyAfterPermissionCheck = vi.fn().mockResolvedValue({
      replyId,
      status: "approval_required",
    });
    const repository = createRepositoryMock({ createReplyAfterPermissionCheck });
    const app = createMessagingTestApp(repository, ownerId, { hermesCapabilitySecret: "test-secret" });
    const replyPath = `/api/messages/conversations/${encodeURIComponent(roomId)}/reply`;

    const rejected = await app.request(replyPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "hermes", body: "I can make that time.", mode: "draft_if_not_allowed" }),
    });
    expect(rejected.status).toBe(403);
    expect(createReplyAfterPermissionCheck).not.toHaveBeenCalled();

    const token = createHermesCapabilityToken({
      secret: "test-secret",
      ownerId,
      roomId,
      scope: "messages.reply.request",
    });
    const accepted = await app.request(replyPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-OS-Hermes-Capability": token,
      },
      body: JSON.stringify({ source: "hermes", body: "I can make that time.", mode: "draft_if_not_allowed" }),
    });
    expect(accepted.status).toBe(202);
    expect(createReplyAfterPermissionCheck).toHaveBeenCalledWith(expect.objectContaining({ ownerId, source: "hermes" }));

    const replayed = await app.request(replyPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-OS-Hermes-Capability": token,
      },
      body: JSON.stringify({ source: "hermes", body: "I can make that time.", mode: "draft_if_not_allowed" }),
    });
    expect(replayed.status).toBe(403);
  });

  it("does not let Hermes capability headers downgrade to user-authenticated replies", async () => {
    const createReplyAfterPermissionCheck = vi.fn().mockResolvedValue({
      replyId,
      status: "approval_required",
    });
    const repository = createRepositoryMock({ createReplyAfterPermissionCheck });
    const app = createMessagingTestApp(repository, ownerId, { hermesCapabilitySecret: "test-secret" });
    const token = createHermesCapabilityToken({
      secret: "test-secret",
      ownerId,
      roomId,
      scope: "messages.reply.request",
    });

    const res = await app.request(`/api/messages/conversations/${encodeURIComponent(roomId)}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matrix-OS-Hermes-Capability": token,
      },
      body: JSON.stringify({ source: "user", body: "I should not be accepted.", mode: "draft_if_not_allowed" }),
    });

    expect(res.status).toBe(403);
    expect(createReplyAfterPermissionCheck).not.toHaveBeenCalled();
  });

  it("lists, approves, and cancels pending drafts owner-scoped", async () => {
    const listDrafts = vi.fn().mockResolvedValue({
      items: [{
        id: replyId,
        ownerId,
        roomId,
        source: "hermes",
        status: "approval_required",
        body: "I can make that time.",
        permissionRevision: 1,
        clientTxnId: "txn_1",
        createdAt: now,
        updatedAt: now,
      }],
    });
    const approveReply = vi.fn().mockResolvedValue({
      replyId,
      status: "sent",
      matrixEventId: "$event:matrixos.local",
    });
    const cancelReply = vi.fn().mockResolvedValue({
      replyId,
      status: "cancelled",
    });
    const repository = createRepositoryMock({ listDrafts, approveReply, cancelReply });
    const app = createMessagingTestApp(repository);

    const listRes = await app.request("/api/messages/drafts");
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toMatchObject({
      drafts: [{ replyId, roomId, source: "hermes", status: "approval_required" }],
    });

    const approveRes = await app.request(`/api/messages/drafts/${replyId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseStatus: "approval_required" }),
    });
    expect(approveRes.status).toBe(202);
    expect(approveReply).toHaveBeenCalledWith({ ownerId, replyId, baseStatus: "approval_required" });

    const cancelRes = await app.request(`/api/messages/drafts/${replyId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "user_cancelled" }),
    });
    expect(cancelRes.status).toBe(200);
    expect(cancelReply).toHaveBeenCalledWith({ ownerId, replyId, reason: "user_cancelled" });
  });
});
