import { Hono } from "hono";
import { vi } from "vitest";
import { createMessagingRoutes } from "../../../packages/gateway/src/messages/routes.js";
import type { MessagingRepository } from "../../../packages/gateway/src/messages/repository.js";

export const ownerId = "user_a";
export const accountId = "acct_0123456789abcdef0123456789abcdef";
export const setupId = "setup_0123456789abcdef0123456789abcdef";
export const conversationId = "conv_0123456789abcdef0123456789abcdef";
export const mappingId = "map_0123456789abcdef0123456789abcdef";
export const now = "2026-05-13T00:00:00.000Z";

export function createRepositoryMock(overrides: Partial<MessagingRepository> = {}): MessagingRepository {
  return {
    listNetworks: vi.fn().mockResolvedValue([
      {
        slug: "telegram",
        displayName: "Telegram",
        setupKind: "api_credentials",
        enabled: true,
        requiresExternalCredentials: true,
      },
      {
        slug: "whatsapp",
        displayName: "WhatsApp",
        setupKind: "qr",
        enabled: true,
        requiresExternalCredentials: false,
      },
    ]),
    listAccounts: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue(null),
    createSetupSession: vi.fn().mockResolvedValue({
      id: setupId,
      ownerId,
      networkSlug: "whatsapp",
      status: "pending",
      qrCode: "matrixos-whatsapp:setup",
      expiresAt: "2026-05-13T00:10:00.000Z",
      createdAt: now,
      updatedAt: now,
    }),
    completeSetupSession: vi.fn().mockResolvedValue({
      id: accountId,
      ownerId,
      networkSlug: "whatsapp",
      externalAccountId: "wa_1",
      displayName: "Personal WhatsApp",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    }),
    disconnectAccount: vi.fn().mockResolvedValue({
      id: accountId,
      ownerId,
      networkSlug: "whatsapp",
      status: "disconnected",
      createdAt: now,
      updatedAt: now,
    }),
    listConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    getMappingByExternalThread: vi.fn().mockResolvedValue(null),
    upsertConversation: vi.fn(),
    upsertConversationMapping: vi.fn(),
    getPermission: vi.fn().mockResolvedValue({
      ownerId,
      roomId: "!room:matrixos.local",
      readEnabled: false,
      replyEnabled: false,
      automationEnabled: false,
      mentionOnly: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }),
    getPermissions: vi.fn().mockResolvedValue({}),
    updatePermission: vi.fn(),
    ingestBridgeEvent: vi.fn(),
    createReply: vi.fn(),
    createReplyAfterPermissionCheck: vi.fn(),
    markReplySending: vi.fn(),
    markReplySent: vi.fn(),
    markReplyFailed: vi.fn(),
    listDrafts: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    getReply: vi.fn().mockResolvedValue(null),
    cancelReply: vi.fn(),
    approveReply: vi.fn(),
    ...overrides,
  };
}

export function createMessagingTestApp(
  repository: MessagingRepository,
  resolvedOwnerId: string | null = ownerId,
  overrides: Partial<MessagingRouteDeps> = {},
) {
  const app = new Hono();
  app.route("/api/messages", createMessagingRoutes({
    repository,
    appserviceToken: "test-appservice-token",
    appserviceOwnerId: ownerId,
    getOwnerId: () => {
      if (!resolvedOwnerId) return "";
      return resolvedOwnerId;
    },
    ...overrides,
  }));
  return app;
}
