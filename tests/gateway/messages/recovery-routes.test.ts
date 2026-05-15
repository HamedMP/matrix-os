import { describe, expect, it, vi } from "vitest";
import { createMessagingTestApp, createRepositoryMock, ownerId, accountId } from "./helpers.js";

describe("messaging recovery routes", () => {
  it("starts recheck, restart, and relink recovery actions for owner accounts", async () => {
    const startRecovery = vi.fn().mockResolvedValue({ accountId, status: "recovery_started" });
    const app = createMessagingTestApp(createRepositoryMock(), ownerId, { startRecovery });

    const res = await app.request(`/api/messages/recovery/${accountId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "relink" }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accountId, status: "recovery_started" });
    expect(startRecovery).toHaveBeenCalledWith({ ownerId, accountId, action: "relink" });
  });

  it("rejects unknown recovery actions before orchestration", async () => {
    const startRecovery = vi.fn();
    const app = createMessagingTestApp(createRepositoryMock(), ownerId, { startRecovery });

    const res = await app.request(`/api/messages/recovery/${accountId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dump_logs" }),
    });

    expect(res.status).toBe(400);
    expect(startRecovery).not.toHaveBeenCalled();
  });
});
