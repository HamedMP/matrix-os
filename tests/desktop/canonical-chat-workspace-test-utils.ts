import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { vi } from "vitest";

export const { snapshot, providerCatalog } = createCanonicalChatFixture("completed");

export const canonicalChatRecord = {
  chat: {
    id: snapshot.chat.id,
    ownerScope: snapshot.chat.ownerScope,
    title: snapshot.chat.title,
    lifecycle: snapshot.chat.lifecycle,
    attention: snapshot.chat.attention,
    revision: snapshot.chat.revision,
    messageCount: snapshot.chat.messageCount,
    lastMessagePreview: snapshot.chat.lastMessagePreview,
    currentSelection: snapshot.chat.currentSelection,
    createdAt: snapshot.chat.createdAt,
    updatedAt: snapshot.chat.updatedAt,
  },
  projectId: "matrix-os",
  providerBinding: snapshot.chat.providerBinding,
};

export function createCanonicalChatWorkspaceClient(): CanonicalChatClient {
  return {
    list: vi.fn(async () => ({ items: [canonicalChatRecord] })),
    search: vi.fn(async () => ({ items: [canonicalChatRecord] })),
    getDetail: vi.fn(async () => ({
      record: canonicalChatRecord,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    })),
    create: vi.fn(),
    updateProject: vi.fn(),
    delete: vi.fn(),
    admitTurn: vi.fn(),
    cancelRun: vi.fn(),
    submitApproval: vi.fn(),
    retryTurn: vi.fn(),
  } as CanonicalChatClient;
}
