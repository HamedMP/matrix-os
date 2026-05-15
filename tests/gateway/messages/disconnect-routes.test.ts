import { describe, expect, it, vi } from "vitest";
import { createMessagingTestApp, createRepositoryMock, ownerId, accountId, now } from "./helpers.js";

describe("messaging disconnect routes", () => {
  it("disconnects an account with keep-history retention by default", async () => {
    const disconnectAccount = vi.fn().mockResolvedValue({
      id: accountId,
      ownerId,
      networkSlug: "whatsapp",
      status: "disconnected",
      createdAt: now,
      updatedAt: now,
    });
    const repository = createRepositoryMock({ disconnectAccount });
    const app = createMessagingTestApp(repository);

    const res = await app.request(`/api/messages/accounts/${accountId}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: accountId, status: "disconnected" });
    expect(disconnectAccount).toHaveBeenCalledWith({ ownerId, accountId, retention: "keep_history" });
  });

  it("passes explicit delete-local-mapping retention", async () => {
    const disconnectAccount = vi.fn().mockResolvedValue({
      id: accountId,
      ownerId,
      networkSlug: "telegram",
      status: "disconnected",
      createdAt: now,
      updatedAt: now,
    });
    const repository = createRepositoryMock({ disconnectAccount });
    const app = createMessagingTestApp(repository);

    const res = await app.request(`/api/messages/accounts/${accountId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention: "delete_local_mapping" }),
    });

    expect(res.status).toBe(200);
    expect(disconnectAccount).toHaveBeenCalledWith({ ownerId, accountId, retention: "delete_local_mapping" });
  });

  it("applies bodyLimit to DELETE before route handling", async () => {
    const disconnectAccount = vi.fn();
    const repository = createRepositoryMock({ disconnectAccount });
    const app = createMessagingTestApp(repository);

    const res = await app.request(`/api/messages/accounts/${accountId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention: "keep_history", padding: "x".repeat(2048) }),
    });

    expect(res.status).toBe(413);
    expect(disconnectAccount).not.toHaveBeenCalled();
  });

  it("rejects malformed account ids before disconnect", async () => {
    const disconnectAccount = vi.fn();
    const repository = createRepositoryMock({ disconnectAccount });
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/accounts/not-an-account", { method: "DELETE" });

    expect(res.status).toBe(400);
    expect(disconnectAccount).not.toHaveBeenCalled();
  });
});
