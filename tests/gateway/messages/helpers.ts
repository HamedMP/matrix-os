import { Hono } from "hono";
import { vi } from "vitest";
import { createMessagingRoutes } from "../../../packages/gateway/src/messages/routes.js";
import type { MessagingKyselyRepository, MessagingRepository } from "../../../packages/gateway/src/messages/repository.js";
import { MessagingBridgeStore } from "../../../packages/gateway/src/messages/bridge-store.js";
import type { MessagingRouteDeps } from "../../../packages/gateway/src/messages/routes.js";

export const ownerId = "user_a";
export const accountId = "acct_0123456789abcdef0123456789abcdef";
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
    enqueueHermesWork: vi.fn(),
    listWorkItems: vi.fn().mockResolvedValue([]),
    createAutomationRule: vi.fn(),
    listAutomationRules: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    pauseAutomationRule: vi.fn(),
    deleteAutomationRule: vi.fn(),
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

/** Records a connected account through the production bridge link path (replaces the 077 stub setup). */
export async function linkTestAccount(
  repository: MessagingKyselyRepository,
  input: { ownerId: string; loginId: string; displayName?: string; network?: "whatsapp" | "telegram" | "linkedin" },
): Promise<{ id: string }> {
  const store = new MessagingBridgeStore(repository.kysely as never);
  await store.bootstrap();
  const { accountId } = await store.recordLinkedAccount({
    ownerId: input.ownerId,
    network: input.network ?? "whatsapp",
    loginId: input.loginId,
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
  return { id: accountId };
}
