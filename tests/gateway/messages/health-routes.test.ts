import { describe, expect, it, vi } from "vitest";
import { createMessagingTestApp, createRepositoryMock, ownerId } from "./helpers.js";

describe("messaging health routes", () => {
  it("returns coarse homeserver and network statuses without upstream details", async () => {
    const getHealth = vi.fn().mockResolvedValue({
      homeserver: "ok",
      networks: [
        { network: "telegram", status: "ok", accountsHealthy: 1, accountsNeedingRelink: 0 },
        { network: "whatsapp", status: "degraded", accountsHealthy: 0, accountsNeedingRelink: 1 },
      ],
    });
    const app = createMessagingTestApp(createRepositoryMock(), ownerId, { getHealth });

    const res = await app.request("/api/messages/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      homeserver: "ok",
      networks: [
        { network: "telegram", status: "ok", accountsHealthy: 1, accountsNeedingRelink: 0 },
        { network: "whatsapp", status: "degraded", accountsHealthy: 0, accountsNeedingRelink: 1 },
      ],
    });
    expect(getHealth).toHaveBeenCalledWith({ ownerId });
  });

  it("maps health probe failures to a generic safe error", async () => {
    const getHealth = vi.fn().mockRejectedValue(new Error("postgres://secret bridge stack"));
    const app = createMessagingTestApp(createRepositoryMock(), ownerId, { getHealth });

    const res = await app.request("/api/messages/health");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal_error", message: "Messaging request failed" } });
  });
});
