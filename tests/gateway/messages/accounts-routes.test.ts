import { describe, expect, it, vi } from "vitest";
import { createMessagingTestApp, createRepositoryMock, ownerId, accountId, now } from "./helpers.js";

describe("messaging account routes", () => {
  it("lists supported Telegram and WhatsApp networks", async () => {
    const repository = createRepositoryMock();
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/networks");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      networks: [
        { slug: "telegram", displayName: "Telegram" },
        { slug: "whatsapp", displayName: "WhatsApp" },
      ],
    });
    expect(repository.listNetworks).toHaveBeenCalledOnce();
  });

  it("lists accounts through the resolved owner scope", async () => {
    const listAccounts = vi.fn().mockResolvedValue([
      {
        id: accountId,
        ownerId,
        networkSlug: "telegram",
        displayName: "Hamed",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const repository = createRepositoryMock({ listAccounts });
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/accounts");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      accounts: [{ id: accountId, networkSlug: "telegram", status: "connected" }],
    });
    expect(listAccounts).toHaveBeenCalledWith({ ownerId });
  });

  it("loads conversation permissions in one repository call", async () => {
    const listConversations = vi.fn().mockResolvedValue({
      items: [{
        id: "conv_0123456789abcdef0123456789abcdef",
        ownerId,
        roomId: "!room:matrixos.local",
        networkSlug: "telegram",
        accountId,
        displayName: "Launch",
        createdAt: now,
        updatedAt: now,
      }],
      nextCursor: undefined,
    });
    const getPermissions = vi.fn().mockResolvedValue({
      "!room:matrixos.local": {
        ownerId,
        roomId: "!room:matrixos.local",
        readEnabled: true,
        replyEnabled: false,
        automationEnabled: false,
        mentionOnly: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    const getPermission = vi.fn();
    const repository = createRepositoryMock({ listConversations, getPermissions, getPermission });
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/conversations");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      items: [{ roomId: "!room:matrixos.local", permissions: { readEnabled: true } }],
    });
    expect(getPermissions).toHaveBeenCalledWith({ ownerId }, ["!room:matrixos.local"]);
    expect(getPermission).not.toHaveBeenCalled();
  });

  it("returns a safe unauthorized envelope when no owner is resolved", async () => {
    const repository = createRepositoryMock();
    const app = createMessagingTestApp(repository, null);

    const res = await app.request("/api/messages/accounts");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
    expect(repository.listAccounts).not.toHaveBeenCalled();
  });

  it("validates conversation list query parameters at the boundary", async () => {
    const repository = createRepositoryMock();
    const app = createMessagingTestApp(repository);

    const res = await app.request("/api/messages/conversations?limit=1000");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_request", message: "Invalid request" } });
    expect(repository.listConversations).not.toHaveBeenCalled();
  });
});
