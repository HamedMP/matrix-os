import { describe, expect, it } from "vitest";
import type { CanonicalChatNavigationItem } from "@matrix-os/contracts";
import { mergeChatNavigationRecord } from "../../packages/ui/src/chat-navigation/projection.js";

function record(): CanonicalChatNavigationItem {
  return {
    chat: { id: "chat_projection", title: "Original", titleVersion: 1, revision: 3,
      lifecycle: "active", attention: "none", messageCount: 4,
      createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" },
    readState: { unread: false, markedUnread: false, version: 2, readThroughSeq: 4, latestIncomingSeq: 4 },
    classification: { kind: "ordinary" }, persistence: "personal",
  };
}
describe("navigation projections preserve independent metadata clocks", () => {
  it.each([3, 4])("applies a newer explicit unread choice at incoming Chat revision %i", revision => {
    const current = record();
    const incoming = { ...current, chat: { ...current.chat, revision },
      readState: { ...current.readState, version: 3, unread: true, markedUnread: true } };
    expect(mergeChatNavigationRecord(current, incoming).readState).toEqual(incoming.readState);
  });
  it("keeps a newer read choice but incorporates incoming replies from an older read version", () => {
    const current = record();
    current.readState = { ...current.readState, version: 8, readThroughSeq: 4 };
    const incoming = { ...record(), chat: { ...current.chat, revision: 4 },
      readState: { ...record().readState, version: 2, readThroughSeq: 6, latestIncomingSeq: 6 } };
    const merged = mergeChatNavigationRecord(current, incoming);
    expect(merged.readState).toMatchObject({ version: 8, readThroughSeq: 4, latestIncomingSeq: 6, unread: true });
    expect(merged.chat.revision).toBe(4);
  });
  it("merges newer title and read versions from a lower Chat revision without downgrading Chat metadata", () => {
    const current = record();
    current.chat = { ...current.chat, revision: 10, messageCount: 8 };
    current.readState = { ...current.readState, latestIncomingSeq: 8, unread: true };
    const incoming = { ...record(), chat: { ...record().chat, revision: 4, title: "Renamed", titleVersion: 2 },
      readState: { ...record().readState, version: 3, readThroughSeq: 6, latestIncomingSeq: 6 } };
    const merged = mergeChatNavigationRecord(current, incoming);
    expect(merged.chat).toMatchObject({ revision: 10, messageCount: 8, title: "Renamed", titleVersion: 2 });
    expect(merged.readState).toMatchObject({ version: 3, readThroughSeq: 6, latestIncomingSeq: 8, unread: true });
  });
});
