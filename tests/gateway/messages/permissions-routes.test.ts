import { describe, expect, it, vi } from "vitest";
import { createMessagingTestApp, createRepositoryMock, ownerId, now } from "./helpers.js";
import { MessagingError } from "../../../packages/gateway/src/messages/errors.js";

const roomId = "!room:matrixos.local";

describe("messaging permission routes", () => {
  it("updates room permissions with optimistic concurrency", async () => {
    const updatePermission = vi.fn().mockResolvedValue({
      ownerId,
      roomId,
      readEnabled: true,
      replyEnabled: false,
      automationEnabled: false,
      mentionOnly: true,
      revision: 2,
      createdAt: now,
      updatedAt: now,
    });
    const repository = createRepositoryMock({ updatePermission });
    const app = createMessagingTestApp(repository);

    const res = await app.request(`/api/messages/conversations/${encodeURIComponent(roomId)}/permissions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseRevision: 1,
        readEnabled: true,
        replyEnabled: false,
        automationEnabled: false,
        mentionOnly: true,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      roomId,
      permissions: { readEnabled: true, revision: 2 },
    });
    expect(updatePermission).toHaveBeenCalledWith({
      ownerId,
      roomId,
      baseRevision: 1,
      readEnabled: true,
      replyEnabled: false,
      automationEnabled: false,
      mentionOnly: true,
      grantedBy: ownerId,
    });
  });

  it("maps stale revisions to safe conflicts", async () => {
    const repository = createRepositoryMock({
      updatePermission: vi.fn().mockRejectedValue(new MessagingError("conflict", "stale postgres constraint", 409)),
    });
    const app = createMessagingTestApp(repository);

    const res = await app.request(`/api/messages/conversations/${encodeURIComponent(roomId)}/permissions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseRevision: 99,
        readEnabled: true,
        replyEnabled: false,
        automationEnabled: false,
        mentionOnly: true,
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "conflict", message: "Conflict" } });
  });

  it("rejects oversized permission bodies before route handling", async () => {
    const updatePermission = vi.fn();
    const repository = createRepositoryMock({ updatePermission });
    const app = createMessagingTestApp(repository);

    const res = await app.request(`/api/messages/conversations/${encodeURIComponent(roomId)}/permissions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(80 * 1024) }),
    });

    expect(res.status).toBe(413);
    expect(updatePermission).not.toHaveBeenCalled();
  });
});
