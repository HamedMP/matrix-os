import { describe, expect, it, vi } from "vitest";
import { createMessagingBridgeHealthService } from "../../../packages/gateway/src/messages/bridge-health.js";
import type { MessagingError } from "../../../packages/gateway/src/messages/errors.js";
import { accountId, createRepositoryMock, ownerId, now } from "./helpers.js";

describe("messaging bridge health service", () => {
  it("does not claim homeserver health without a real probe", async () => {
    const repository = createRepositoryMock({
      listAccounts: vi.fn().mockResolvedValue([
        { id: accountId, ownerId, networkSlug: "whatsapp", status: "connected", createdAt: now, updatedAt: now },
      ]),
    });
    const service = createMessagingBridgeHealthService(repository);

    await expect(service.getHealth({ ownerId })).resolves.toMatchObject({
      homeserver: "unknown",
      networks: [
        { network: "telegram", status: "unknown", accountsHealthy: 0, accountsNeedingRelink: 0 },
        { network: "whatsapp", status: "ok", accountsHealthy: 1, accountsNeedingRelink: 0 },
      ],
    });
  });

  it("rejects recovery actions that are not wired to an executor", async () => {
    const repository = createRepositoryMock({
      getAccount: vi.fn().mockResolvedValue({
        id: accountId,
        ownerId,
        networkSlug: "whatsapp",
        status: "error",
        createdAt: now,
        updatedAt: now,
      }),
    });
    const service = createMessagingBridgeHealthService(repository);

    await expect(service.startRecovery({ ownerId, accountId, action: "relink" })).rejects.toMatchObject({
      code: "not_implemented",
      status: 501,
    } satisfies Partial<MessagingError>);
    await expect(service.startRecovery({ ownerId, accountId, action: "recheck" })).rejects.toMatchObject({
      code: "not_implemented",
      status: 501,
    } satisfies Partial<MessagingError>);
  });
});
