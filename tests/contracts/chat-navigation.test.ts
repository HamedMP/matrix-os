import { describe, expect, it } from "vitest";
import { CanonicalChatNavigationItemSchema, CanonicalChatNavigationResponseSchema, CanonicalChatNavigationQuerySchema, CanonicalChatListResponseSchema } from "@matrix-os/contracts";
const item = { chat: { id: "chat_navigation", title: "Navigation", titleVersion: 0, lifecycle: "active", attention: "none", revision: 0, messageCount: 0, userState: { readThroughSeq: 0, pinned: false, muted: false }, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z" }, classification: { kind: "ordinary" }, persistence: "personal", readState: { unread: false, markedUnread: false, version: 0, readThroughSeq: 0, latestIncomingSeq: 0 } };
describe("navigation wire contract", () => {
  it("requires explicit classification and rejects execution/content fields", () => {
    expect(CanonicalChatNavigationItemSchema.parse(item)).toEqual(item);
    expect(CanonicalChatNavigationItemSchema.safeParse({ ...item, classification: undefined }).success).toBe(false);
    expect(CanonicalChatNavigationItemSchema.safeParse({ ...item, chat: { ...item.chat, currentSelection: {} } }).success).toBe(false);
    expect(CanonicalChatNavigationItemSchema.safeParse({ ...item, classification: { kind: "bot" } }).success).toBe(false);
  });
  it("bounds snapshots and query input independently of legacy list", () => {
    expect(CanonicalChatNavigationQuerySchema.parse({})).toEqual({ version: 1, limit: 1000 });
    expect(CanonicalChatNavigationQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
    expect(CanonicalChatNavigationQuerySchema.safeParse({ ownerId: "other" }).success).toBe(false);
    expect(CanonicalChatNavigationResponseSchema.parse({ version: 1, items: [item], truncated: false }).items).toHaveLength(1);
    expect(CanonicalChatNavigationResponseSchema.safeParse({ version: 2, items: [], truncated: false }).success).toBe(false);
    expect(CanonicalChatNavigationResponseSchema.safeParse({ version: 1, items: Array(1001).fill(item), truncated: false }).success).toBe(false);
    expect(CanonicalChatListResponseSchema.safeParse({ version: 1, items: [item], truncated: false }).success).toBe(false);
  });
});
