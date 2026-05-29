import { describe, expect, it, vi } from "vitest";
import { createMessagingTestApp, createRepositoryMock, ownerId, setupId, accountId, now } from "./helpers.js";

describe("messaging setup routes", () => {
  it("starts a WhatsApp setup session with a bounded request body", async () => {
    const createSetupSession = vi.fn().mockResolvedValue({
      id: setupId,
      ownerId,
      networkSlug: "whatsapp",
      status: "pending",
      qrCode: "matrixos-whatsapp:setup",
      expiresAt: "2026-05-13T00:10:00.000Z",
      createdAt: now,
      updatedAt: now,
    });
    const repository = createRepositoryMock({ createSetupSession });
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/accounts/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ networkSlug: "whatsapp" }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ id: setupId, networkSlug: "whatsapp", status: "pending" });
    expect(createSetupSession).toHaveBeenCalledWith({ ownerId, networkSlug: "whatsapp" });
  });

  it("rejects unsupported setup networks before touching the repository", async () => {
    const createSetupSession = vi.fn();
    const repository = createRepositoryMock({ createSetupSession });
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/accounts/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ networkSlug: "signal" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_request", message: "Invalid request" } });
    expect(createSetupSession).not.toHaveBeenCalled();
  });

  it("applies bodyLimit before setup route handling", async () => {
    const createSetupSession = vi.fn();
    const repository = createRepositoryMock({ createSetupSession });
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/accounts/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ networkSlug: "whatsapp", padding: "x".repeat(80 * 1024) }),
    });

    expect(res.status).toBe(413);
    expect(createSetupSession).not.toHaveBeenCalled();
  });

  it("completes setup with a path-validated setup id", async () => {
    const completeSetupSession = vi.fn().mockResolvedValue({
      id: accountId,
      ownerId,
      networkSlug: "telegram",
      externalAccountId: "tg_1",
      displayName: "Telegram",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
    const repository = createRepositoryMock({ completeSetupSession });
    const app = createMessagingTestApp(repository);

    const res = await app.request(`/api/messages/accounts/setup/${setupId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalAccountId: "tg_1", displayName: "Telegram" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: accountId, status: "connected" });
    expect(completeSetupSession).toHaveBeenCalledWith({
      ownerId,
      setupId,
      externalAccountId: "tg_1",
      displayName: "Telegram",
    });
  });

  it("rejects malformed setup ids before completion", async () => {
    const completeSetupSession = vi.fn();
    const repository = createRepositoryMock({ completeSetupSession });
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/accounts/setup/bad/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(completeSetupSession).not.toHaveBeenCalled();
  });
});
