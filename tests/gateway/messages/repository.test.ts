import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import {
  MessagingKyselyRepository,
  type MessagingBridgeAccountProvider,
} from "../../../packages/gateway/src/messages/repository.js";

const ownerId = "user_a";
const otherOwnerId = "user_b";

function provider(): MessagingBridgeAccountProvider {
  return {
    beginSetup: vi.fn(async ({ networkSlug, setupId }) => ({
      setupUrl: networkSlug === "telegram" ? `matrixos://messages/setup/telegram/${setupId}` : undefined,
      qrCode: networkSlug === "whatsapp" ? `matrixos-whatsapp:${setupId}` : undefined,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })),
    disconnect: vi.fn(async () => {}),
  };
}

describe("MessagingKyselyRepository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: MessagingKyselyRepository;
  let whatsappProvider: MessagingBridgeAccountProvider;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    whatsappProvider = provider();
    repository = new MessagingKyselyRepository(pglite.dialect, { whatsapp: whatsappProvider });
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.destroy();
  });

  it("bootstraps messaging tables idempotently and lists supported networks", async () => {
    await repository.bootstrap();

    await expect(repository.listNetworks()).resolves.toMatchObject([
      { slug: "telegram", enabled: true },
      { slug: "whatsapp", enabled: true },
    ]);
  });

  it("creates and completes setup sessions into owner-scoped connected accounts", async () => {
    const setup = await repository.createSetupSession({ ownerId, networkSlug: "whatsapp" });

    expect(setup.status).toBe("pending");
    expect(setup.qrCode).toContain(setup.id);
    expect(whatsappProvider.beginSetup).toHaveBeenCalledWith({
      ownerId,
      networkSlug: "whatsapp",
      setupId: setup.id,
    });

    const account = await repository.completeSetupSession({
      ownerId,
      setupId: setup.id,
      externalAccountId: "wa_1",
      displayName: "Personal WhatsApp",
    });

    expect(account).toMatchObject({
      ownerId,
      networkSlug: "whatsapp",
      externalAccountId: "wa_1",
      displayName: "Personal WhatsApp",
      status: "connected",
    });
    await expect(repository.listAccounts({ ownerId })).resolves.toHaveLength(1);
    await expect(repository.listAccounts({ ownerId: otherOwnerId })).resolves.toHaveLength(0);
  });

  it("uses the external account unique index as the account idempotency key", async () => {
    const firstSetup = await repository.createSetupSession({ ownerId, networkSlug: "whatsapp" });
    const first = await repository.completeSetupSession({
      ownerId,
      setupId: firstSetup.id,
      externalAccountId: "wa_same",
      displayName: "Original",
    });

    const secondSetup = await repository.createSetupSession({ ownerId, networkSlug: "whatsapp" });
    const second = await repository.completeSetupSession({
      ownerId,
      setupId: secondSetup.id,
      externalAccountId: "wa_same",
      displayName: "Updated",
    });

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe("Updated");
    await expect(repository.listAccounts({ ownerId })).resolves.toHaveLength(1);
  });

  it("upserts conversations and bridge-local mappings by canonical external thread", async () => {
    const setup = await repository.createSetupSession({ ownerId, networkSlug: "whatsapp" });
    const account = await repository.completeSetupSession({
      ownerId,
      setupId: setup.id,
      externalAccountId: "wa_1",
      displayName: "Personal WhatsApp",
    });

    const conversation = await repository.upsertConversation({
      ownerId,
      roomId: "!room:matrixos.local",
      networkSlug: "whatsapp",
      accountId: account.id,
      displayName: "Family",
      lastEventAt: "2026-05-13T00:00:00.000Z",
    });
    const mapping = await repository.upsertConversationMapping({
      ownerId,
      networkSlug: "whatsapp",
      accountId: account.id,
      roomId: conversation.roomId,
      externalThreadId: "wa_thread_1",
      authoritative: true,
    });
    const duplicate = await repository.upsertConversationMapping({
      ownerId,
      networkSlug: "whatsapp",
      accountId: account.id,
      roomId: conversation.roomId,
      externalThreadId: "wa_thread_1",
      authoritative: true,
    });

    expect(duplicate.id).toBe(mapping.id);
    await expect(repository.getMappingByExternalThread({
      ownerId,
      networkSlug: "whatsapp",
      accountId: account.id,
      externalThreadId: "wa_thread_1",
    })).resolves.toMatchObject({ id: mapping.id, roomId: conversation.roomId });
    await expect(repository.listConversations({ ownerId })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: conversation.id, displayName: "Family" })],
    });
  });

  it("disconnects accounts and can remove local bridge mappings in the same transaction", async () => {
    const setup = await repository.createSetupSession({ ownerId, networkSlug: "whatsapp" });
    const account = await repository.completeSetupSession({
      ownerId,
      setupId: setup.id,
      externalAccountId: "wa_1",
      displayName: "Personal WhatsApp",
    });
    await repository.upsertConversation({
      ownerId,
      roomId: "!room:matrixos.local",
      networkSlug: "whatsapp",
      accountId: account.id,
      displayName: "Family",
    });
    await repository.upsertConversationMapping({
      ownerId,
      networkSlug: "whatsapp",
      accountId: account.id,
      roomId: "!room:matrixos.local",
      externalThreadId: "wa_thread_1",
      authoritative: true,
    });

    const disconnected = await repository.disconnectAccount({
      ownerId,
      accountId: account.id,
      retention: "delete_local_mapping",
    });

    expect(disconnected.status).toBe("disconnected");
    expect(whatsappProvider.disconnect).toHaveBeenCalledWith({
      ownerId,
      networkSlug: "whatsapp",
      accountId: account.id,
    });
    await expect(repository.getMappingByExternalThread({
      ownerId,
      networkSlug: "whatsapp",
      accountId: account.id,
      externalThreadId: "wa_thread_1",
    })).resolves.toBeNull();
  });

  it("rejects repeat completion of the same setup session", async () => {
    const setup = await repository.createSetupSession({ ownerId, networkSlug: "whatsapp" });
    await repository.completeSetupSession({
      ownerId,
      setupId: setup.id,
      externalAccountId: "wa_once",
      displayName: "Personal WhatsApp",
    });

    await expect(repository.completeSetupSession({
      ownerId,
      setupId: setup.id,
      externalAccountId: "wa_twice",
      displayName: "Duplicate WhatsApp",
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("marks an account unhealthy when bridge disconnect fails after local commit", async () => {
    const setup = await repository.createSetupSession({ ownerId, networkSlug: "whatsapp" });
    const account = await repository.completeSetupSession({
      ownerId,
      setupId: setup.id,
      externalAccountId: "wa_fail_disconnect",
      displayName: "Personal WhatsApp",
    });
    vi.mocked(whatsappProvider.disconnect).mockRejectedValueOnce(new Error("bridge down"));

    await expect(repository.disconnectAccount({
      ownerId,
      accountId: account.id,
      retention: "keep_history",
    })).rejects.toMatchObject({ code: "provider_unavailable" });

    await expect(repository.getAccount({ ownerId }, account.id)).resolves.toMatchObject({
      id: account.id,
      status: "error",
      statusReason: "bridge disconnect failed",
    });
  });

});
